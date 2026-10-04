const fs = require('fs');
const path = require('path');
const os = require('os');
const { ethers } = require('ethers');
const config = require('./config');
const { provider, erc20, priceUsd, usdOf, rawFromUsd, gasPrice } = require('./lib/chain');
const { deriveSubWallet, checkFingerprint } = require('./lib/subwallet');
const { encryptSecret, decryptSecret, isEncrypted } = require('./lib/secrets');
const { buildSwapCalldata } = require('./lib/v3');
const registry = require('./lib/registry');
const publish = require('./lib/publish');
const routerCoins = require('./lib/routerCoins');
const v4 = require('./lib/v4');
const lighter = require('./lighter/client');

/**
 * keeper.js — il loop perpspad su Robinhood Chain
 *
 * Ogni TICK_MS, per ogni coin nel registry:
 *   1. CLAIM     locker.collect(lpTokenId): le fee (coin + quote) arrivano al
 *                sub-wallet. Gli importi REALI si misurano dal delta di balance
 *                attorno alla collect (non dalla static: la static predice, la tx
 *                incassa un valore diverso — la deriva si accumulerebbe).
 *   2. SPLIT     lato quote 50/15/20/15 (perp/creator/treasury/buyback) — bps da
 *                config, resto dell'intero al bucket perp (somma esatta al wei).
 *   3. BURN      lato coin: bruciato l'intero saldo coin del sub-wallet (recupera
 *                anche eventuali residui di burn falliti in passato).
 *   4. PAYOUT    creator e treasury pagati appena il dovuto supera $1.
 *   5. BUYBACK   sopra $25: swap quote→coin (max $25/tick) con amountOutMinimum
 *                reale dal prezzo spot (anti-sandwich), poi burn.
 *   6. PERP      la riserva 50% accumula nel sub-wallet; al gate $20 → lighter
 *                (stub in fase 1).
 *
 * Sicurezza dei fondi:
 *  - CHECKPOINT per-step: lo stato si salva DOPO ogni tx e, per payout/buyback,
 *    il bucket si decrementa e si salva PRIMA di inviare. Un crash hard lascia
 *    quindi un UNDER-pay (fondi fermi nel sub-wallet, riconciliabili) e mai un
 *    DOUBLE-pay. Un fallimento soft ripristina il bucket e si ritenta al tick dopo.
 *  - LOCKFILE single-instance: due keeper condividerebbero sub-wallet/nonce.
 *  - Cap su gasPrice per il funding dei sub-wallet (anti-drain da RPC ostile).
 *  - Timeout su wait(): una tx "stuck" non congela l'intero loop.
 *
 * Due venue, stessa contabilita':
 *  - `venue: 'v4'` (coin lanciate dal MultiplyLaunchRouter su Doppler/Uniswap v4): la coin
 *    entra nel registry da sola dagli eventi del router; le fee arrivano in USDG sul suo
 *    MultiplyFeeSink (fissato al lancio, senza setter), che il keeper ADOTTA puntandolo al
 *    sub-wallet una volta sola e poi FLUSHA (15% treasury / 80% sub-wallet dentro il
 *    contratto, coin bruciati). Il buyback compra sul pool v4 via Universal Router + Permit2.
 *  - legacy V3 (le coin di test con LP nel locker): collect() e SwapRouter02, invariati.
 *
 * Uso: node keeper.js [--once] [--coin 0x…]
 */

const flag = (name) => process.argv.includes('--' + name);
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ts = () => new Date().toISOString().slice(11, 19);
const BN = ethers.BigNumber.from;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOCKER_ABI = [
  'function collect(uint256 tokenId) returns (uint256 amount0, uint256 amount1)',
  'function feeRecipient(uint256) view returns (address)',
];
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
];
const SINK_ABI = [
  'function destination() view returns (address)',
  'function pending() view returns (uint256 numeraireHeld, uint256 assetHeld)',
  'function setDestination(address destination_)',
  'function flush() returns (uint256 toTreasury, uint256 toDestination, uint256 burned)',
  'event Flushed(uint256 toTreasury, uint256 toDestination, uint256 burned)',
];
const LOCKFILE = path.join(config.STATE_DIR, 'keeper.lock');
const Q96 = BN(2).pow(96);
// un log che deve comparire una volta per coin, non a ogni tick
function logOnce(st, key, checkpoint, msg) {
  if (st[key]) return;
  console.log(msg);
  st[key] = true;
  checkpoint();
}

function keeperWallet() {
  const key = process.env.PERPSPAD_KEEPER_KEY || config.DEPLOYER_KEY;
  if (!key) throw new Error('PERPSPAD_KEEPER_KEY o DEPLOYER_PRIVATE_KEY mancante');
  return new ethers.Wallet(key, provider);
}

// gasPrice usato per INVIARE, sempre cappato: un RPC ostile che gonfia il prezzo
// non deve poter dimensionare top-up enormi ne' bruciare gas a piacere.
async function cappedGasPrice() {
  const gp = await gasPrice();
  const cap = BN(config.MAX_GAS_PRICE_WEI);
  return gp.gt(cap) ? cap : gp;
}

// wait() con timeout: oltre WAIT_TIMEOUT_MS la tx e' considerata "stuck" e si
// solleva un errore (soft) invece di bloccare il loop per sempre.
// L'errore porta il flag `stuck`: la tx e' ancora VIVA in mempool e puo' minare
// dopo — chi gestisce il fallimento NON deve trattarla come annullata (un
// ripristino del bucket qui produrrebbe un double-pay quando la tx mina).
class StuckTxError extends Error {
  constructor(label, hash, ms) {
    super(`${label}: tx ${hash} non minata entro ${ms}ms (stuck, ancora in mempool)`);
    this.stuck = true;
    this.hash = hash;
  }
}
const isStuck = (e) => !!(e && e.stuck);

async function waitOrTimeout(txResp, label) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new StuckTxError(label, txResp.hash, config.WAIT_TIMEOUT_MS)), config.WAIT_TIMEOUT_MS); });
  try { return await Promise.race([txResp.wait(), timeout]); }
  finally { clearTimeout(timer); }
}

async function send(wallet, tx, label) {
  // Su Arbitrum Orbit il costo di posting L1 e' addebitato come UNITA' di gas
  // extra: i limiti fissi (21000 in testa) sono insufficienti. Stima reale con
  // margine 30%; se la stima fallisce (hiccup RPC) si ripiega sul limite fornito.
  // Il gasLimit di fallback NON va passato a estimateGas: il nodo lo userebbe
  // come tetto e la stima fallirebbe proprio quando serve di piu' (misurato:
  // collect del locker = 323k contro un fallback di 300k).
  const { gasLimit: fallbackLimit, ...estTx } = tx;
  let gasLimit = fallbackLimit;
  try { gasLimit = (await wallet.estimateGas(estTx)).mul(13).div(10); } catch { /* fallback al limite fornito */ }
  const r = await wallet.sendTransaction({ gasPrice: await cappedGasPrice(), type: 0, ...tx, gasLimit });
  const rc = await waitOrTimeout(r, label);
  if (rc.status !== 1) throw new Error(label + ' revertata: ' + r.hash);
  return rc;
}

// il sub-wallet paga gas per burn/payout/swap: il keeper lo tiene rifornito.
// Floor e top-up dal gasPrice CAPPATO (non manipolabile oltre il cap).
async function ensureGas(keeper, subAddr) {
  const gp = await cappedGasPrice();
  const floor = gp.mul(config.GAS_TICK_UNITS);
  const bal = await provider.getBalance(subAddr);
  if (bal.gte(floor)) return;
  const topup = floor.mul(config.GAS_TOPUP_MULT);
  console.log(`  gas top-up ${subAddr} (+${ethers.utils.formatEther(topup)} ETH)`);
  await send(keeper, { to: subAddr, value: topup, gasLimit: 21000 }, 'gas top-up');
}

async function burnCoin(sub, coinToken, amount, st) {
  if (amount.isZero()) return;
  const c = erc20(coinToken, sub);
  try {
    await send(sub, { to: coinToken, data: c.interface.encodeFunctionData('burn', [amount]), gasLimit: 80000 }, 'burn');
  } catch {
    await send(sub, { to: coinToken, data: c.interface.encodeFunctionData('transfer', ['0x000000000000000000000000000000000000dEaD', amount]), gasLimit: 80000 }, 'burn(dead)');
  }
  st.totalBurnedRaw = BN(st.totalBurnedRaw).add(amount).toString();
}

// ── logica tranche del take-profit (helper puri, testabili a secco) ──────────
// Ogni deposito/topup e' una tranche {base, entryMark, collateralUsd, sizeDec, ts}.
// Su Lighter la posizione resta UNA (nettata): le tranche sono contabilita' del
// keeper e decidono solo QUANTO chiudere e QUANDO.

// prezzo target di una tranche: il sottostante deve muoversi di triggerPct/leva
function trancheTargetMark(entryMark, side, leverage, triggerPct) {
  const move = triggerPct / leverage;
  return side === 'short' ? entryMark * (1 - move) : entryMark * (1 + move);
}

// mark implicito dalla posizione Lighter (coerente col loro PnL: mark = entry ± pnl/size)
function markFromPosition(pos, side) {
  const size = Math.abs(Number(pos.size)), entry = Number(pos.avg_entry_price), pnl = Number(pos.unrealized_pnl);
  if (!isFinite(size) || size <= 0 || !isFinite(entry) || entry <= 0 || !isFinite(pnl)) return null;
  return side === 'short' ? entry - pnl / size : entry + pnl / size;
}

// riconcilia le tranche con la size REALE on-chain (posBase, int scalato sizeDec).
// La verita' e' sempre Lighter: liquidata → azzera; piu' piccola → scala pro-quota;
// piu' grande (migrazione/recupero registry) → tranche sintetica all'entry corrente.
function reconcileTranches(tranches, posBase, mark, sizeDec) {
  const sum = tranches.reduce((a, t) => a + t.base, 0);
  if (posBase <= 0) {
    return { tranches: [], changed: sum !== 0, note: sum !== 0 ? 'posizione sparita (liquidata o chiusa fuori dal keeper): tranche azzerate' : null };
  }
  if (sum === posBase) return { tranches, changed: false, note: null };
  if (posBase > sum) {
    const synth = { base: posBase - sum, entryMark: mark, collateralUsd: 0, sizeDec, ts: Date.now(), synthetic: true };
    return { tranches: [...tranches, synth], changed: true, note: `size on-chain > contabilita': tranche sintetica da ${posBase - sum} unita' all'entry corrente` };
  }
  // posBase < sum: funding/riduzioni esterne → scala proporzionale, resto alla piu' grande.
  // Il resto si assegna PRIMA di scartare le tranche azzerate dal floor: con un libro
  // di tranche minuscole (le schegge del finding #8) il floor puo' azzerarle tutte, e
  // filtrare per prime lasciava il libro vuoto con la posizione ancora aperta. Al tick
  // dopo sarebbe rientrata come sintetica al mark corrente, cioe' con l'entry sbagliata
  // e il target del take-profit falsato. L'indice si sceglie sulle base ORIGINALI,
  // che sono le uniche informative quando le scalate sono tutte a zero.
  const factor = posBase / sum;
  const scaled = tranches.map((t) => ({ ...t, base: Math.floor(t.base * factor) }));
  const acc = scaled.reduce((a, t) => a + t.base, 0);
  const rem = posBase - acc;
  if (rem > 0 && scaled.length) {
    let iMax = 0;
    for (let i = 1; i < tranches.length; i++) if (tranches[i].base > tranches[iMax].base) iMax = i;
    scaled[iMax].base += rem;
  }
  const kept = scaled.filter((t) => t.base > 0);
  return { tranches: kept, changed: true, note: `tranche riscalate a ${posBase} unita' (contabilita' era ${sum})` };
}

// Registra una tranche nuova, FONDENDO i fill-scheggia nella precedente.
// Una tranche piu' piccola del minimo d'ordine del mercato non potrebbe MAI essere
// chiusa da sola: non deve esistere come entita' separata. Succede quando il saldo
// "libero" e' gonfiato dal PnL non ancora realizzato (misurato live su HYPE 20x:
// sei micro-tranche da 1-17 unita' contro un minimo di 100). La fusione con entry
// medio pesato e' anche il valore contabilmente corretto.
function addTranche(tranches, t, minBaseUnits) {
  const last = tranches[tranches.length - 1];
  if (last && t.base < (minBaseUnits || 1)) {
    const total = last.base + t.base;
    last.entryMark = (last.entryMark * last.base + t.entryMark * t.base) / total;
    last.base = total;
    last.collateralUsd = (last.collateralUsd || 0) + (t.collateralUsd || 0);
    last.ts = t.ts;
    return { tranches, merged: true };
  }
  tranches.push(t);
  return { tranches, merged: false };
}

// separa le tranche mature (target raggiunto) da quelle ancora in corsa
function matureTranches(tranches, mark, side, leverage, triggerPct) {
  const ready = [], keep = [];
  for (const t of tranches) {
    const target = trancheTargetMark(t.entryMark, side, leverage, triggerPct);
    const hit = side === 'short' ? mark <= target : mark >= target;
    (hit ? ready : keep).push(t);
  }
  return { ready, keep };
}

// consuma `closedBase` unita' dalla lista (gia' ordinata: piu' vecchie prima) e
// restituisce cio' che RESTA — le tranche non riempite tornano in coda al TP.
function removeClosedBase(tranches, closedBase) {
  let left = Math.max(0, Math.round(closedBase));
  const out = [];
  for (const t of tranches) {
    if (left <= 0) { out.push(t); continue; }
    if (t.base <= left) { left -= t.base; continue; }   // tranche chiusa interamente
    out.push({ ...t, base: t.base - left });            // chiusa a meta': resta il residuo
    left = 0;
  }
  return out;
}

// profitto realizzato chiudendo le tranche al mark corrente (esatto, non stimato)
function realizedFromTranches(tranches, mark, side, sizeDec) {
  return tranches.reduce((a, t) => {
    const perUnit = side === 'short' ? t.entryMark - mark : mark - t.entryMark;
    return a + perUnit * (t.base / 10 ** sizeDec);
  }, 0);
}

// Delta di funding dall'ultimo tick, per mercato.
//
// Il perp paga (o incassa) funding a ogni round e quel flusso finisce direttamente
// nel collaterale su Lighter. La contabilita' a tranche, invece, calcola il
// realizzato come (mark - entry) x size: SOLO prezzo. Senza riconciliare il
// funding, perpRealizedUsd rivendica piu' di quanto c'e' davvero sul conto e il
// withdraw dello step 8 finisce per prelevare margine — o viene rifiutato e
// ritentato all'infinito mentre il buco cresce.
//
// `total_funding_paid_out` e' CUMULATIVO e vive quanto la posizione, quindi si
// tiene l'ultimo valore visto e si applica solo la differenza. La baseline si
// ricostruisce dalle sole posizioni PRESENTI: quando una posizione sparisce la
// sua baseline cade da sola, e una posizione nuova sullo stesso mercato riparte
// da zero senza generare un credito fantasma.
function fundingDelta(seen, positions) {
  const prev = seen && typeof seen === 'object' ? seen : {};
  const next = {};
  let delta = 0;
  for (const p of positions || []) {
    const mid = String(p.market_id);
    const cum = Number(p.total_funding_paid_out);
    // campo assente (API vecchia o mercato senza funding): la baseline si conserva
    // com'e', cosi' un buco temporaneo nella risposta non si traduce in un delta.
    if (!isFinite(cum)) {
      if (prev[mid] !== undefined) next[mid] = prev[mid];
      continue;
    }
    delta += cum - Number(prev[mid] || 0);
    next[mid] = cum;
  }
  return { delta, seen: next };
}

// output ESATTO di un exact-in swap V3 in un range a liquidita' costante (i pool
// perpspad sono a posizione singola one-sided → L costante nel range: esatto).
// Formule canoniche SqrtPriceMath, identiche a uniQuote.js del repo.
function quoteExactInV3(sqrtP, L, amountInNet, zeroForOne) {
  // Liquidita' nulla nel tick attivo: il pool non puo' eseguire. Senza questa guardia
  // il ramo token1-in divide per L e solleva division-by-zero, che nel buyback si
  // presenterebbe come errore opaco del tick invece di uno skip pulito. (La copia
  // lato web in SwapPanel la guardia ce l'aveva gia': qui mancava.)
  if (L.isZero()) return ethers.constants.Zero;
  if (zeroForOne) {
    // token0 in → token1 out, prezzo scende
    const sqrtNext = L.mul(Q96).mul(sqrtP).div(L.mul(Q96).add(amountInNet.mul(sqrtP)));
    return L.mul(sqrtP.sub(sqrtNext)).div(Q96);
  }
  // token1 in → token0 out, prezzo sale
  const sqrtNext = sqrtP.add(amountInNet.mul(Q96).div(L));
  return L.mul(Q96).mul(sqrtNext.sub(sqrtP)).div(sqrtNext.mul(sqrtP));
}

// minOut del buyback: quoto l'output reale al prezzo/liquidita' CORRENTI del pool
// (tiene conto dell'impatto di prezzo) e tolgo la tolleranza di slippage. Se un
// sandwich/volume ha spostato il prezzo tra il quote e l'esecuzione, lo swap
// reverta e si ritenta al tick dopo — niente leak da amountOutMinimum:0.
/**
 * Quanti quote (in unita' umane) valgono `coinRaw` unita' RAW di coin, allo spot.
 *
 * sqrtPriceX96 codifica il prezzo RAW di token1 per token0. Restando in raw su
 * entrambi i lati non serve alcun fattore per i 18 decimali della coin: basta
 * girare il rapporto secondo chi dei due e' il quote e dividere per i decimali
 * del quote alla fine. Funzione pura: e' coperta dai test a secco.
 */
function coinValueInQuote(sqrtPriceX96, coinRaw, quoteIs0, pairDecimals) {
  const p = Number(sqrtPriceX96.toString()) ** 2 / 2 ** 192;   // raw token1 per raw token0
  if (!isFinite(p) || p <= 0) return 0;
  const quoteRawPerCoinRaw = quoteIs0 ? 1 / p : p;
  const quoteRaw = Number(coinRaw.toString()) * quoteRawPerCoinRaw;
  if (!isFinite(quoteRaw)) return 0;
  return quoteRaw / 10 ** pairDecimals;
}

// Da dove arrivano le FEE sul sub-wallet, per venue: dal pool V3 (collect del locker) o dal
// sink v4 (flush). Serve alla riconciliazione del withdraw (step 0a), che accredita come
// profitto rientrato dal bridge ogni inflow di USDG che NON sia una fee. Senza il caso v4,
// `coin.pool` e' undefined e il tick della coin esploderebbe a ogni giro dopo il primo
// take-profit, cioe' esattamente quando il motore deve chiudere il cerchio.
function isFeeInflow(coin, from) {
  const source = coin.venue === 'v4' ? coin.sink : coin.pool;
  return !!source && String(from).toLowerCase() === source.toLowerCase();
}

// valore in USD del lato coin delle fee, allo spot del pool: serve al gate del
// claim per "vedere" anche la parte bruciabile
async function coinSideUsd(coin, coinRaw, quoteIs0, unitUsd) {
  const pool = new ethers.Contract(coin.pool, POOL_ABI, provider);
  const { sqrtPriceX96 } = await pool.slot0();
  return coinValueInQuote(sqrtPriceX96, coinRaw, quoteIs0, coin.pairDecimals) * unitUsd;
}

async function buybackMinOut(coin, quoteIs0, spendRaw) {
  const pool = new ethers.Contract(coin.pool, POOL_ABI, provider);
  const [{ sqrtPriceX96 }, L] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const net = spendRaw.mul(1000000 - coin.fee).div(1000000); // fee presa sull'input
  const out = quoteExactInV3(sqrtPriceX96, L, net, quoteIs0); // quote in = token0 ⇔ zeroForOne
  return out.mul(10000 - config.BUYBACK_MAX_SLIPPAGE_BPS).div(10000);
}

// ── piani di buyback per venue: approvazioni + quote + calldata, lo swap lo invia il tick ──

// V3: approve del quote al SwapRouter02, minOut dalla formula chiusa sul range one-sided
async function buybackPlanV3(sub, coin, quote, quoteIs0, spendRaw) {
  const allowance = await quote.allowance(sub.address, config.SWAP_ROUTER);
  if (allowance.lt(spendRaw)) {
    await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('approve', [config.SWAP_ROUTER, ethers.constants.MaxUint256]), gasLimit: 80000 }, 'approve router');
  }
  const minOut = await buybackMinOut(coin, quoteIs0, spendRaw);
  const data = buildSwapCalldata({ tokenIn: coin.pair, tokenOut: coin.token, fee: coin.fee, recipient: sub.address, amountIn: spendRaw, amountOutMinimum: minOut });
  return { to: config.SWAP_ROUTER, data, minOut, gasLimit: 400000 };
}

// v4: USDG → Permit2 (una volta, max), Permit2 → Universal Router (allowance ampia ma a
// scadenza), quote dal Doppler Quoter al netto della hook fee corrente, poi V4_SWAP exact-in.
async function buybackPlanV4(sub, coin, quote, spendRaw) {
  const erc20ToPermit2 = await quote.allowance(sub.address, config.PERMIT2);
  if (erc20ToPermit2.lt(spendRaw)) {
    await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('approve', [config.PERMIT2, ethers.constants.MaxUint256]), gasLimit: 80000 }, 'approve Permit2');
  }
  // allowance Permit2 → router limitata a QUESTO buyback e a un'ora: il sub-wallet tiene tutte
  // le fee della coin in USDG, e una allowance ampia sarebbe il raggio d'azione di un bug altrui
  const now = Math.floor(Date.now() / 1000);
  const p2 = await v4.permit2Allowance(provider, sub.address, coin.pair);
  if (p2.amount.lt(spendRaw) || p2.expiration < now + 600) {
    await send(sub, { to: config.PERMIT2, data: v4.encodePermit2Approve(coin.pair, spendRaw, now + config.PERMIT2_EXPIRY_S), gasLimit: 80000 }, 'Permit2 approve router');
  }
  const q = await v4.quoteExactInV4(provider, { asset: coin.token, numeraire: coin.pair, tokenIn: coin.pair, amountIn: spendRaw, nowSec: now });
  // il pool quotato DEVE essere quello che il router ha emesso al lancio
  if (q.poolId.toLowerCase() !== String(coin.poolId).toLowerCase()) throw new Error(`pool id ricalcolato ${q.poolId} diverso da quello del lancio ${coin.poolId}: buyback fermato`);
  if (q.out.isZero()) throw new Error('quote v4 a zero: nessuna liquidita dall altra parte della scala');
  const minOut = q.out.mul(10000 - config.BUYBACK_MAX_SLIPPAGE_BPS).div(10000);
  const data = v4.buildV4SwapCalldata({ poolKey: q.poolKey, tokenIn: coin.pair, tokenOut: coin.token, amountIn: spendRaw, amountOutMinimum: minOut, nowSec: now });
  return { to: config.UNIVERSAL_ROUTER, data, minOut, gasLimit: 500000, hookFee: q.hookFee };
}

// ── incasso fee per venue ───────────────────────────────────────────────────

// V3: collect() del locker. Il gate valuta ENTRAMBI i lati (il lato coin e' bruciabile e
// altrimenti resterebbe invisibile con pressione in vendita); gli importi REALI si misurano
// dal delta di saldo, la static predice soltanto. Il lato coin lo brucia il locker dentro la
// collect (0xdEaD), quindi si misura dal delta di totalSupply.
async function claimV3(keeper, locker, coin, st, checkpoint, sub, unitUsd, quote, coinC, quoteIs0) {
  let est, estCoin;
  try {
    const [a0, a1] = await locker.callStatic.collect(coin.lpTokenId);
    est = quoteIs0 ? a0 : a1;
    estCoin = quoteIs0 ? a1 : a0;
  }
  catch (e) { console.log(`  [${coin.symbol}] static collect fallita: ${e.message.slice(0, 80)}`); return false; }

  let claimableUsd = usdOf(est, coin.pairDecimals, unitUsd);
  if (claimableUsd < config.CLAIM_MIN_USD && estCoin.gt(0)) {
    claimableUsd += await coinSideUsd(coin, estCoin, quoteIs0, unitUsd).catch(() => 0);
  }
  if (claimableUsd < config.CLAIM_MIN_USD) return true;

  const quoteBefore = await quote.balanceOf(sub.address);
  const supplyBefore = await coinC.totalSupply().catch(() => null);
  await send(keeper, { to: config.LOCKER, data: locker.interface.encodeFunctionData('collect', [coin.lpTokenId]), gasLimit: 300000 }, 'collect');
  const realQuote = (await quote.balanceOf(sub.address)).sub(quoteBefore);
  if (supplyBefore) {
    const supplyAfter = await coinC.totalSupply().catch(() => null);
    if (supplyAfter && supplyBefore.gt(supplyAfter)) {
      const burnedByLocker = supplyBefore.sub(supplyAfter);
      st.totalBurnedRaw = BN(st.totalBurnedRaw).add(burnedByLocker).toString();
      console.log(`  [${coin.symbol}] burn del locker: ${ethers.utils.formatEther(burnedByLocker)} ${coin.symbol}`);
    }
  }
  bookFeeIncome(st, realQuote);
  checkpoint();
  console.log(`  [${coin.symbol}] claim: ${ethers.utils.formatUnits(realQuote, coin.pairDecimals)} ${coin.pairSymbol} ($${usdOf(realQuote, coin.pairDecimals, unitUsd).toFixed(2)})`);
  return true;
}

// v4: il sink della coin. Prima l'ADOZIONE (destination = sub-wallet, una volta, dal keeper
// autorizzato sul router), poi il flush quando vale il gas. I coin eventualmente parcheggiati
// sul hook (swap interno non eseguibile, audit M2) si liberano con collectFees() e il flush li
// brucia. Gli importi vengono dall'evento Flushed: esatti, non stimati.
async function claimV4(keeper, coin, st, checkpoint, sub, unitUsd) {
  if (!coin.sink) {
    logOnce(st, 'sinkMissingLogged', checkpoint, `  [${coin.symbol}] nessun sink sul router per questa coin (router pre-upgrade?): fee sull'hub, niente da incassare`);
    return;
  }
  const sink = new ethers.Contract(coin.sink, SINK_ABI, provider);

  if (!coin.sinkAdopted) {
    const dst = await sink.destination();
    if (BN(dst).isZero()) {
      const router = new ethers.Contract(config.LAUNCH_ROUTER, routerCoins.ROUTER_IFACE, provider);
      const allowed = await router.keeper().catch(() => null);
      if (allowed && allowed.toLowerCase() !== keeper.address.toLowerCase()) {
        logOnce(st, 'sinkKeeperMismatchLogged', checkpoint, `  [${coin.symbol}] il router autorizza ${allowed} come keeper del sink, non ${keeper.address}: adozione impossibile con questa chiave`);
        return;
      }
      await send(keeper, { to: coin.sink, data: sink.interface.encodeFunctionData('setDestination', [sub.address]), gasLimit: 80000 }, 'sink setDestination');
      coin.sinkAdopted = true; checkpoint();
      console.log(`  [${coin.symbol}] sink ${coin.sink} adottato: destination = sub-wallet ${sub.address}`);
    } else if (dst.toLowerCase() === sub.address.toLowerCase()) {
      coin.sinkAdopted = true; checkpoint();
    } else {
      // il flush manderebbe l'USDG a un indirizzo che non e' nostro: mai chiamarlo
      logOnce(st, 'sinkForeignDestinationLogged', checkpoint, `  [${coin.symbol}] ATTENZIONE: il sink punta a ${dst}, non al sub-wallet ${sub.address}: coin NON servita`);
      return;
    }
  }

  const hf = await v4.hookFees(provider, coin.poolId).catch(() => null);
  if (hf && (hf.beneficiaryFees0.gt(0) || hf.beneficiaryFees1.gt(0))) {
    await send(keeper, { to: config.REHYPE, data: v4.REHYPE_IFACE.encodeFunctionData('collectFees', [coin.token]), gasLimit: 300000 }, 'rehype collectFees');
    console.log(`  [${coin.symbol}] fee parcheggiate sul hook liberate verso il sink`);
  }

  const [held, coinHeld] = await sink.pending();
  const heldUsd = usdOf(held, coin.pairDecimals, unitUsd);
  if (heldUsd < config.CLAIM_MIN_USD && coinHeld.isZero()) return;

  const rc = await send(keeper, { to: coin.sink, data: sink.interface.encodeFunctionData('flush'), gasLimit: 250000 }, 'sink flush');
  let toTreasury = ethers.constants.Zero, toDestination = ethers.constants.Zero, burned = ethers.constants.Zero;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== coin.sink.toLowerCase()) continue;
    try {
      const ev = sink.interface.parseLog(l);
      if (ev.name === 'Flushed') { toTreasury = ev.args.toTreasury; toDestination = ev.args.toDestination; burned = ev.args.burned; }
    } catch { /* altro evento */ }
  }
  st.sinkTreasuryRaw = BN(st.sinkTreasuryRaw || '0').add(toTreasury).toString();
  if (burned.gt(0)) st.totalBurnedRaw = BN(st.totalBurnedRaw).add(burned).toString();
  bookFeeIncome(st, toDestination);
  checkpoint();
  console.log(`  [${coin.symbol}] flush: $${usdOf(toDestination, coin.pairDecimals, unitUsd).toFixed(2)} al sub-wallet, $${usdOf(toTreasury, coin.pairDecimals, unitUsd).toFixed(2)} alla treasury${burned.gt(0) ? `, ${ethers.utils.formatEther(burned)} ${coin.symbol} bruciati dal sink` : ''}`);
}

// ── 2. SPLIT dell'incasso in bucket (resto al perp: somma esatta al wei) ────
function bookFeeIncome(st, realQuote) {
  st.totalCollected0 = BN(st.totalCollected0).add(realQuote).toString();
  const creatorCut = realQuote.mul(config.SPLIT_BPS.creator).div(10000);
  const treasuryCut = realQuote.mul(config.SPLIT_BPS.treasury).div(10000);
  const buybackCut = realQuote.mul(config.SPLIT_BPS.buyback).div(10000);
  const perpCut = realQuote.sub(creatorCut).sub(treasuryCut).sub(buybackCut);
  st.perpReserveRaw = BN(st.perpReserveRaw).add(perpCut).toString();
  st.creatorOwedRaw = BN(st.creatorOwedRaw).add(creatorCut).toString();
  st.treasuryOwedRaw = BN(st.treasuryOwedRaw).add(treasuryCut).toString();
  st.buybackReserveRaw = BN(st.buybackReserveRaw).add(buybackCut).toString();
}

async function tickCoin(keeper, locker, coin, st, checkpoint) {
  const token = coin.token;
  const sub = deriveSubWallet(token, provider);
  const quoteIs0 = BN(coin.pair).lt(BN(token));
  const unitUsd = priceUsd(coin.pair, coin.pairSymbol);
  const quote = erc20(coin.pair);
  const coinC = erc20(token);

  // una coin lanciata con metadata non validi non ha un motore: le sue fee restano
  // visibili nel sink e nessuna posizione viene mai aperta (niente da servire)
  if (coin.engineError) {
    logOnce(st, 'engineErrorLogged', checkpoint, `  [${coin.symbol}] motore non configurabile (${coin.engineError}): coin non servita`);
    return;
  }

  // ── 0-pre. WITHDRAW con esito ambiguo da un run precedente: promuovi a pending ─
  // Il write-ahead dello step 8 lascia perpWithdrawIntentUsd > 0 se il processo e'
  // morto (o il sidecar e' andato in timeout) DOPO l'invio ma prima della conferma.
  // Trattarlo come inviato e' la scelta sicura: se il withdraw non e' mai partito,
  // il pending resta li' senza credito (0a accredita solo USDG arrivati davvero).
  if (Number(st.perpWithdrawIntentUsd) > 0) {
    const amt = Number(st.perpWithdrawIntentUsd);
    st.perpWithdrawPendingUsd = Number(st.perpWithdrawPendingUsd || 0) + amt;
    st.perpWithdrawIntentUsd = 0;
    if (!st.perpWithdrawBlock) { st.perpWithdrawBlock = await provider.getBlockNumber(); st.perpWithdrawScanBlock = st.perpWithdrawBlock - 1; }
    checkpoint();
    console.log(`  [${coin.symbol}] withdraw con esito ambiguo ($${amt.toFixed(2)}): trattato come inviato — verra' accreditato solo all'arrivo reale`);
  }

  // ── 0a. WITHDRAW: credito SOLO dagli USDG davvero arrivati dal bridge ────────
  // Match per MITTENTE, non per surplus aggregato: gli inflow dal pool sono fee,
  // qualunque altro inflow durante la finestra del withdraw e' il settlement.
  // Cosi' fee incassate da collect() esterne o fondi orfani non vengono piu'
  // scambiati per profitto, e il profitto vero non resta orfano.
  if (Number(st.perpWithdrawPendingUsd) > 0) {
    if (!st.perpWithdrawBlock) { st.perpWithdrawBlock = await provider.getBlockNumber(); st.perpWithdrawScanBlock = st.perpWithdrawBlock - 1; checkpoint(); }
    const latest = await provider.getBlockNumber();
    const fromBlock = Number(st.perpWithdrawScanBlock ?? st.perpWithdrawBlock - 1) + 1;
    if (latest >= fromBlock) {
      const transferTopic = quote.interface.getEventTopic('Transfer');
      const logs = await provider.getLogs({
        address: coin.pair, fromBlock, toBlock: latest,
        topics: [transferTopic, null, ethers.utils.hexZeroPad(sub.address, 32)],
      });
      let bridgedRaw = ethers.constants.Zero;
      for (const l of logs) {
        const ev = quote.interface.parseLog(l);
        if (!isFeeInflow(coin, ev.args.from)) bridgedRaw = bridgedRaw.add(ev.args.value);
      }
      const pendingRaw = rawFromUsd(Number(st.perpWithdrawPendingUsd), coin.pairDecimals, unitUsd);
      const creditRaw = bridgedRaw.lt(pendingRaw) ? bridgedRaw : pendingRaw;
      st.perpWithdrawScanBlock = latest;
      if (creditRaw.gt(0) && usdOf(creditRaw, coin.pairDecimals, unitUsd) >= config.CLAIM_MIN_USD) {
        const toTreasury = creditRaw.mul(config.TP_MASTER_SHARE_BPS).div(10000);
        const toBuyback = creditRaw.sub(toTreasury);
        st.buybackReserveRaw = BN(st.buybackReserveRaw).add(toBuyback).toString();
        st.treasuryOwedRaw = BN(st.treasuryOwedRaw).add(toTreasury).toString();
        st.perpWithdrawPendingUsd = Math.max(0, Number(st.perpWithdrawPendingUsd) - usdOf(creditRaw, coin.pairDecimals, unitUsd));
        if (st.perpWithdrawPendingUsd < 0.01) { st.perpWithdrawPendingUsd = 0; st.perpWithdrawBlock = null; st.perpWithdrawScanBlock = null; }
        console.log(`  [${coin.symbol}] profitto perp rientrato dal bridge: $${usdOf(creditRaw, coin.pairDecimals, unitUsd).toFixed(2)} → 75% buyback / 25% treasury`);
      }
      checkpoint(); // persiste comunque lo scanBlock (mai ricontare gli stessi log)
    }
  }

  // ── 0b. SWEEP: surplus non attribuito → perp reserve ────────────────────────
  // Qualunque USDG del sub-wallet oltre i bucket noti (fee incassate da collect()
  // esterne, fondi rimasti orfani da un crash, invii di terzi) torna a lavorare
  // nel motore. Con lo split 100% perp e' anche la destinazione naturale.
  {
    const accounted = BN(st.buybackReserveRaw).add(st.creatorOwedRaw).add(st.treasuryOwedRaw).add(st.perpReserveRaw);
    const real = await quote.balanceOf(sub.address);
    const surplus = real.gt(accounted) ? real.sub(accounted) : ethers.constants.Zero;
    if (usdOf(surplus, coin.pairDecimals, unitUsd) >= config.CLAIM_MIN_USD) {
      st.perpReserveRaw = BN(st.perpReserveRaw).add(surplus).toString();
      checkpoint();
      console.log(`  [${coin.symbol}] sweep: $${usdOf(surplus, coin.pairDecimals, unitUsd).toFixed(2)} non attribuiti → perp reserve`);
    }
  }

  // ── 1+2. CLAIM e SPLIT, per venue (v4: sink; V3: locker) ────────────────────
  if (coin.venue === 'v4') {
    await claimV4(keeper, coin, st, checkpoint, sub, unitUsd);
  } else if (!(await claimV3(keeper, locker, coin, st, checkpoint, sub, unitUsd, quote, coinC, quoteIs0))) {
    return; // la static collect non risponde: il tick di questa coin si ferma qui, come prima
  }

  // ── 3. BURN lato coin: brucia l'INTERO saldo coin del sub-wallet ───────────
  //     (fee lato coin di questo claim + eventuali residui di burn passati falliti)
  const coinBal = await coinC.balanceOf(sub.address);
  if (coinBal.gt(0)) {
    await ensureGas(keeper, sub.address);
    await burnCoin(sub, token, coinBal, st);
    checkpoint();
    console.log(`  [${coin.symbol}] burn lato coin: ${ethers.utils.formatEther(coinBal)} ${coin.symbol}`);
  }

  // ── 4. PAYOUT creator + treasury (min $1), save-before-send ────────────────
  for (const [bucket, dest, label] of [
    ['creatorOwedRaw', coin.creator, 'creator'],
    ['treasuryOwedRaw', config.TREASURY, 'treasury'],
  ]) {
    const owed = BN(st[bucket]);
    if (owed.isZero()) continue;
    if (!dest) { if (bucket === 'treasuryOwedRaw') console.log(`  [${coin.symbol}] PERPSPAD_TREASURY non settata: accumulo`); continue; }
    if (usdOf(owed, coin.pairDecimals, unitUsd) < config.CREATOR_MIN_PAYOUT_USD) continue;
    await ensureGas(keeper, sub.address);
    st[bucket] = '0'; checkpoint(); // decremento PRIMA dell'invio: un crash → under-pay, mai double-pay
    try {
      await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('transfer', [dest, owed]), gasLimit: 100000 }, label);
      console.log(`  [${coin.symbol}] payout ${label}: ${ethers.utils.formatUnits(owed, coin.pairDecimals)} ${coin.pairSymbol} → ${dest}`);
    } catch (e) {
      // Ripristina SOLO se la tx e' morta davvero (revert/errore d'invio). Se e'
      // solo "stuck" puo' ancora minare: ripristinare qui significherebbe ri-pagare
      // al tick dopo → double-pay. Meglio un bucket a 0 (under-pay riconciliabile).
      if (!isStuck(e)) { st[bucket] = owed.toString(); checkpoint(); }
      else console.log(`  [${coin.symbol}] payout ${label} STUCK (${e.hash}): bucket NON ripristinato, verifica la tx prima di ri-accreditare`);
      throw e;
    }
  }

  // ── 5. BUYBACK & BURN (floor $25, max $25/tick, slippage reale) ────────────
  const bbUsd = usdOf(BN(st.buybackReserveRaw), coin.pairDecimals, unitUsd);
  if (bbUsd >= config.BUYBACK_FLOOR_USD) {
    const spendUsd = Math.min(bbUsd, config.BUYBACK_MAX_PER_TICK_USD);
    let spendRaw = rawFromUsd(spendUsd, coin.pairDecimals, unitUsd);
    if (spendRaw.gt(BN(st.buybackReserveRaw))) spendRaw = BN(st.buybackReserveRaw);
    await ensureGas(keeper, sub.address);
    const plan = coin.venue === 'v4'
      ? await buybackPlanV4(sub, coin, quote, spendRaw)
      : await buybackPlanV3(sub, coin, quote, quoteIs0, spendRaw);
    const minOut = plan.minOut;
    const before = await coinC.balanceOf(sub.address);
    st.buybackReserveRaw = BN(st.buybackReserveRaw).sub(spendRaw).toString(); checkpoint(); // decremento prima dell'invio
    // Il try copre SOLO lo swap: se fallisce lui, gli USDG non sono usciti e la
    // riserva si puo' ripristinare. Misura e burn stanno fuori — un loro errore
    // dopo uno swap riuscito non deve MAI ri-accreditare USDG gia' spesi (il
    // saldo coin resta nel sub-wallet e lo brucia lo step 3 al tick dopo).
    let swapped = false;
    try {
      await send(sub, { to: plan.to, data: plan.data, gasLimit: plan.gasLimit }, 'buyback swap');
      swapped = true;
    } catch (e) {
      if (!isStuck(e)) {
        st.buybackReserveRaw = BN(st.buybackReserveRaw).add(spendRaw).toString(); checkpoint();
        console.log(`  [${coin.symbol}] buyback fallito (slippage?), riprovo al tick dopo: ${e.message.slice(0, 80)}`);
      } else {
        console.log(`  [${coin.symbol}] buyback STUCK (${e.hash}): riserva NON ripristinata, la tx puo' ancora minare`);
      }
    }
    if (swapped) {
      const bought = (await coinC.balanceOf(sub.address)).sub(before);
      await burnCoin(sub, token, bought, st);
      checkpoint();
      console.log(`  [${coin.symbol}] BUYBACK&BURN: $${spendUsd.toFixed(2)} → ${ethers.utils.formatEther(bought)} ${coin.symbol} bruciati (minOut ${ethers.utils.formatEther(minOut)})`);
    }
  }

  // ── 6. PERP su Lighter (o stub) ───────────────────────────────────────────
  const perpUsd = usdOf(BN(st.perpReserveRaw), coin.pairDecimals, unitUsd);
  if (lighter.enabled) {
    try { await perpTick(keeper, coin, st, checkpoint, sub, unitUsd, quote); }
    catch (e) { console.log(`  [${coin.symbol}] perp: ${e.message.slice(0, 140)}`); }
  } else if (perpUsd >= config.OPEN_GATE_USD && !st.perpGateLogged) {
    console.log(`  [${coin.symbol}] PERP (stub): riserva $${perpUsd.toFixed(2)} ≥ $${config.OPEN_GATE_USD} → ${coin.market} ${coin.side} ${coin.leverage}x quando Lighter sara' attivo (PERPSPAD_LIGHTER_ENABLED)`);
    st.perpGateLogged = true; checkpoint();
  }

  st.lastTickTs = Date.now();
}

// ── gamba perp su Lighter (profilo ROBINHOOD) ───────────────────────────────
// Collaterale USDG che entra da Robinhood Chain (4663) via intent-address; ogni
// sub-wallet e' il proprio account Lighter. Contabilita' conservativa: la riserva
// perp si decrementa SOLO quando gli USDG lasciano davvero il sub-wallet verso
// l'intent-address; il profitto realizzato resta su Lighter (serve un withdraw
// per bruciarlo) e NON viene accreditato al buyback finche' non torna on-chain.
// quanta size e' USCITA davvero dalla posizione dopo un close (fill reale).
// Rilegge la posizione e confronta con la size attesa prima dell'ordine; su
// errore di lettura resta conservativo (0 = nessun credito, si ritenta al tick dopo).
async function closedBaseAfter(accountIndex, marketIndex, side, sizeDec, baseBefore, requested) {
  try {
    const acc = await lighter.account(accountIndex);
    const p = (acc.positions || []).find((x) => Number(x.market_id) === Number(marketIndex));
    const after = p && p.size != null ? Math.round(Math.abs(Number(p.size)) * 10 ** sizeDec) : 0;
    return Math.max(0, Math.min(requested, baseBefore - after));
  } catch (e) {
    console.log(`  fill non verificabile (${e.message.slice(0, 60)}): nessun credito, ritento al tick dopo`);
    return 0;
  }
}

// speculare per l'open: quanta size e' ENTRATA davvero (fill reale dell'IOC).
async function openedBaseAfter(accountIndex, marketIndex, sizeDec, baseBefore, requested) {
  try {
    const acc = await lighter.account(accountIndex);
    const p = (acc.positions || []).find((x) => Number(x.market_id) === Number(marketIndex));
    const after = p && p.size != null ? Math.round(Math.abs(Number(p.size)) * 10 ** sizeDec) : 0;
    return Math.max(0, Math.min(requested, after - baseBefore));
  } catch (e) {
    console.log(`  fill open non verificabile (${e.message.slice(0, 60)}): nessuna tranche registrata, la riconciliazione sistemera' al tick dopo`);
    return 0;
  }
}

async function perpTick(keeper, coin, st, checkpoint, sub, unitUsd, quote) {
  if (coin.pair.toLowerCase() !== config.USDG.toLowerCase()) {
    if (!st.perpGateLogged) { console.log(`  [${coin.symbol}] perp saltato: quote non USDG (il collaterale Lighter e' USDG)`); st.perpGateLogged = true; checkpoint(); }
    return;
  }
  const sim = lighter.simulate; // dry-run: letture ok, nessuna tx/ordine
  const tag = sim ? 'SIMULATE ' : '';
  // mercato Lighter della coin (BTC, NVDA, NVDA/USDG, …)
  const mkt = await lighter.market(coin.market);
  const marketIndex = mkt.index;
  const isAsk = coin.side === 'short'; // long = buy (is_ask false)

  // 1) DEPOSITO: manda la riserva accumulata all'intent-address (tx reale su 4663)
  const perpUsd = usdOf(BN(st.perpReserveRaw), coin.pairDecimals, unitUsd);
  const gate = st.perpOpen ? config.TOPUP_STEP_USD : config.OPEN_GATE_USD;
  if (perpUsd >= gate) {
    const depositRaw = BN(st.perpReserveRaw);
    const { intentAddress } = await lighter.intentAddress({ chainId: '4663', fromAddr: sub.address, amount: depositRaw.toString() });
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}perp deposit: depositerei $${perpUsd.toFixed(2)} USDG → Lighter (intent ${intentAddress})`);
    } else {
      await ensureGas(keeper, sub.address);
      st.perpReserveRaw = '0'; st.perpPendingDepositUsd += perpUsd; checkpoint(); // decremento prima dell'invio (crash → under-deposit, riconciliabile)
      try {
        await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('transfer', [intentAddress, depositRaw]), gasLimit: 100000 }, 'perp deposit');
        st.perpDepositedUsd += perpUsd; checkpoint();
        console.log(`  [${coin.symbol}] perp deposit: $${perpUsd.toFixed(2)} USDG → Lighter (intent ${intentAddress})`);
      } catch (e) {
        // Come per il payout: ripristina la riserva SOLO se la tx e' morta. Se e'
        // stuck puo' ancora minare e un ripristino porterebbe a depositare due volte.
        if (!isStuck(e)) { st.perpReserveRaw = depositRaw.toString(); st.perpPendingDepositUsd = Math.max(0, st.perpPendingDepositUsd - perpUsd); checkpoint(); }
        else console.log(`  [${coin.symbol}] perp deposit STUCK (${e.hash}): riserva NON ripristinata, la tx puo' ancora minare`);
        throw e;
      }
    }
  }

  // 2) account Lighter della coin (creato al primo deposito accreditato)
  let accountIndex = st.lighterAccountIndex;
  if (accountIndex == null) {
    const r = await lighter.resolveAccount(sub.address);
    if (r.accountIndex == null) { if (sim) console.log(`  [${coin.symbol}] ${tag}account Lighter non ancora attivo (nessun deposito accreditato)`); return; }
    accountIndex = r.accountIndex;
    if (!sim) { st.lighterAccountIndex = accountIndex; checkpoint(); }
    console.log(`  [${coin.symbol}] ${tag}account Lighter ${accountIndex} attivo`);
  }

  // 3) chiave API della coin (per firmare gli ordini); registrata con la chiave del
  //    sub-wallet e salvata CIFRATA (AES-GCM da master secret): il registry da solo
  //    non basta piu' per pilotare le posizioni.
  if (!st.lighterApiPrivKey) {
    if (sim) { console.log(`  [${coin.symbol}] ${tag}registrerei la chiave API (idx ${config.LIGHTER_API_KEY_INDEX})`); return; }
    const r = await lighter.registerKey({ accountIndex, apiKeyIndex: config.LIGHTER_API_KEY_INDEX, ethPrivKey: sub.privateKey });
    st.lighterApiPrivKey = encryptSecret(r.apiPrivKey); st.lighterApiKeyIndex = r.apiKeyIndex; checkpoint();
    console.log(`  [${coin.symbol}] chiave API Lighter registrata (idx ${r.apiKeyIndex})`);
  }
  // migrazione: chiavi salvate in chiaro da versioni precedenti → ri-cifra
  if (!sim && st.lighterApiPrivKey && !isEncrypted(st.lighterApiPrivKey)) {
    st.lighterApiPrivKey = encryptSecret(st.lighterApiPrivKey); checkpoint();
    console.log(`  [${coin.symbol}] chiave API migrata a storage cifrato`);
  }
  const apiPrivKey = decryptSecret(st.lighterApiPrivKey), apiKeyIndex = st.lighterApiKeyIndex;

  // 4) leva isolata, una volta
  if (!st.lighterLeverageSet) {
    if (sim) { console.log(`  [${coin.symbol}] ${tag}imposterei leva ${coin.leverage}x ${config.LIGHTER_ISOLATED ? 'isolated' : 'cross'}`); }
    else {
      await lighter.setLeverage({ accountIndex, marketIndex, leverage: coin.leverage, isolated: config.LIGHTER_ISOLATED, apiPrivKey, apiKeyIndex });
      st.lighterLeverageSet = true; checkpoint();
      console.log(`  [${coin.symbol}] leva ${coin.leverage}x ${config.LIGHTER_ISOLATED ? 'isolated' : 'cross'} impostata su ${coin.market}`);
    }
  }

  // 5) stato conto/posizione. Il saldo LIBERO e' available_balance: `collateral`
  //    in modalita' cross INCLUDE il margine delle posizioni (verificato su API) e
  //    usarlo come deployable causerebbe topup compounding fino alla liquidazione.
  const acc = await lighter.account(accountIndex);
  const pos = (acc.positions || []).find((p) => Number(p.market_id) === Number(marketIndex));
  const freeCollateralUsd = Number(acc.available_balance ?? acc.collateral ?? 0);
  let openedBaseThisTick = 0; // size aperta DOPO questa lettura di pos (vedi step 7)

  // 5b) FUNDING. Il funding non passa dalle tranche (che misurano solo il prezzo)
  //     ma e' gia' stato addebitato o accreditato sul collaterale: va portato nel
  //     realizzato, altrimenti perpRealizedUsd e il conto divergono in silenzio e
  //     il withdraw dello step 8 preleva margine invece di profitto.
  //     Delta negativo = funding PAGATO: riduce il realizzato (fino a renderlo
  //     negativo, cioe' un debito che il prossimo take-profit ripaga prima di
  //     poter prelevare). Positivo = incassato: e' profitto del perp come un altro,
  //     e segue la stessa strada verso il buyback&burn.
  {
    const f = fundingDelta(st.perpFundingSeen, acc.positions);
    st.perpFundingSeen = f.seen;
    if (Math.abs(f.delta) >= 0.000001) {
      st.perpFundingUsd = Number(st.perpFundingUsd || 0) + f.delta;
      st.perpRealizedUsd = Number(st.perpRealizedUsd || 0) + f.delta;
      if (!sim) checkpoint();
      console.log(`  [${coin.symbol}] ${tag}funding ${f.delta >= 0 ? '+' : ''}$${f.delta.toFixed(6)} (cumulato $${Number(st.perpFundingUsd).toFixed(6)}): realizzato ora $${Number(st.perpRealizedUsd).toFixed(2)}`);
    }
  }

  // 6) OPEN / TOPUP: deploya il collaterale libero al leverage scelto.
  //    Il profitto gia' REALIZZATO (perpRealizedUsd) resta fuori dal deployable:
  //    e' in coda per il withdraw (step 8) e non va ri-lockato in posizione —
  //    altrimenti dopo una chiusura totale (profilo safe) il withdraw fallirebbe.
  //    Si impiega solo COLLATERAL_HEADROOM del libero: Lighter valuta il margine al
  //    prezzo di esecuzione, quindi senza buffer l'ordine viene scartato in silenzio
  //    appena il prezzo si muove tra la lettura del mark e il fill.
  //    La riserva si clampa a zero: un realizzato NEGATIVO (funding pagato piu' del
  //    profitto, step 5b) e' un debito, non collaterale in piu' da impiegare.
  const usableUsd = Math.max(0, freeCollateralUsd - Math.max(0, Number(st.perpRealizedUsd || 0)));
  const deployableUsd = usableUsd * config.COLLATERAL_HEADROOM;
  const minNotional = Math.max(mkt.minQuoteUsd || 0, 0);
  if (deployableUsd >= config.MIN_DEPLOY_USD && deployableUsd * coin.leverage < minNotional) {
    if (!st.perpBelowMinLogged) {
      console.log(`  [${coin.symbol}] collaterale insufficiente per il minimo d'ordine: $${(deployableUsd * coin.leverage).toFixed(2)} di notional < $${minNotional.toFixed(2)} richiesti da ${coin.market} — accumulo`);
      st.perpBelowMinLogged = true; if (!sim) checkpoint();
    }
  } else if (deployableUsd >= config.MIN_DEPLOY_USD) {
    st.perpBelowMinLogged = false;
    const wasOpen = st.perpOpen;
    const notionalUsd = deployableUsd * coin.leverage;
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}perp ${wasOpen ? 'topup' : 'open'}: aprirei notional $${notionalUsd.toFixed(2)} ${coin.side} ${coin.leverage}x (deployable $${deployableUsd.toFixed(2)}, riservato al withdraw $${Math.max(0, Number(st.perpRealizedUsd || 0)).toFixed(2)})`);
    } else {
      const baseBefore = pos && pos.size != null ? Math.round(Math.abs(Number(pos.size)) * 10 ** mkt.sizeDec) : 0;
      const r = await lighter.open({ accountIndex, marketIndex, notionalUsd, isAsk, maxSlippage: config.LIGHTER_MAX_SLIPPAGE, clientOrderIndex: Date.now() % 1000000, apiPrivKey, apiKeyIndex });
      // IOC: "accettato" NON significa "riempito" — misurato live su NVDA in
      // pre-market: ordine ok, fill zero. La tranche si registra SOLO per la
      // size davvero entrata in posizione, e il collaterale contabilizzato e'
      // proporzionale al fill; il resto resta deployable e si ritenta.
      const filled = await openedBaseAfter(accountIndex, marketIndex, mkt.sizeDec, baseBefore, Number(r.baseAmount) || 0);
      if (filled > 0) {
        const fillFrac = Math.min(1, filled / (Number(r.baseAmount) || filled));
        const usedCollateralUsd = deployableUsd * fillFrac;
        st.perpOpen = true;
        st.perpCollateralUsd += usedCollateralUsd;
        st.perpPendingDepositUsd = Math.max(0, st.perpPendingDepositUsd - usedCollateralUsd);
        if (!Array.isArray(st.perpTranches)) st.perpTranches = [];
        // entry = mark usato dal sidecar per dimensionare; se manca, niente append:
        // la riconciliazione del tick dopo crea la sintetica.
        let merged = false;
        if (r.mark) {
          ({ merged } = addTranche(st.perpTranches, { base: filled, entryMark: Number(r.mark), collateralUsd: usedCollateralUsd, sizeDec: mkt.sizeDec, ts: Date.now() }, mkt.minBaseUnits));
          // la `pos` letta allo step 5 e' PRECEDENTE a quest'ordine: senza tenerne
          // conto la riconciliazione dello step 7 vedrebbe le tranche "in eccesso"
          // e le riscalerebbe tutte (proprio la diluizione che le tranche evitano).
          openedBaseThisTick += filled;
        }
        checkpoint();
        console.log(`  [${coin.symbol}] perp ${wasOpen ? 'topup' : 'open'}: notional $${notionalUsd.toFixed(2)} ${coin.side} ${coin.leverage}x (fill ${filled}/${r.baseAmount} @ ${r.mark})${merged ? ' — scheggia fusa nella tranche precedente' : ''}`);
      } else {
        console.log(`  [${coin.symbol}] perp open NON riempito (IOC senza controparte: book vuoto o mercato chiuso?): collaterale intatto, riprovo al tick dopo`);
      }
    }
  }

  // 7) TAKE-PROFIT per tranche: riconcilia la contabilita' con la size on-chain,
  //    poi chiude (reduce-only) le tranche il cui target e' stato raggiunto.
  //    Ogni tranche corre verso il SUO entry × (1 ± trigger/leva): i topup non
  //    diluiscono il progresso delle tranche vecchie.
  const prof = config.RISK_PROFILES[coin.riskProfile] || config.RISK_PROFILES[config.DEFAULT_RISK];
  if (!Array.isArray(st.perpTranches)) st.perpTranches = [];
  {
    // size on-chain al netto di cio' che abbiamo aperto DOPO la lettura di pos.
    // pos assente = nessuna posizione (chiusa/liquidata): posBase 0, non skip —
    // altrimenti le tranche morte sopravviverebbero e inquinerebbero la prossima.
    const posBaseRaw = pos && pos.size != null ? Math.round(Math.abs(Number(pos.size)) * 10 ** mkt.sizeDec) : 0;
    const posBase = posBaseRaw + openedBaseThisTick;
    const mark = pos ? markFromPosition(pos, coin.side) : null;

    if (posBase <= 0) {
      // posizione sparita: azzera la contabilita' (il ramo non usa il mark)
      const rec = reconcileTranches(st.perpTranches, 0, 0, mkt.sizeDec);
      if (rec.changed) {
        st.perpTranches = rec.tranches; st.perpOpen = false;
        if (!sim) checkpoint();
        console.log(`  [${coin.symbol}] ${tag}tranches: ${rec.note}`);
      }
    } else if (mark != null) {
      const rec = reconcileTranches(st.perpTranches, posBase, mark, mkt.sizeDec);
      if (rec.changed) {
        st.perpTranches = rec.tranches;
        if (!sim) checkpoint();
        if (rec.note) console.log(`  [${coin.symbol}] ${tag}tranches: ${rec.note}`);
      }
      // perpOpen deve rispecchiare il venue, non essere una latch a senso unico.
      // Veniva messo a true SOLO da un fill nostro: se il libro veniva ricostruito
      // da una tranche sintetica (posizione viva scoperta in riconciliazione) il
      // flag restava false per sempre. Conseguenze reali: lo step 6 sceglieva
      // OPEN_GATE invece di TOPUP_STEP, e la home mostrava "Accumulating" su una
      // coin col perp aperto (letto da `st.perpOpen` in web/lib/detail.ts).
      if (!st.perpOpen) {
        st.perpOpen = true;
        if (!sim) checkpoint();
        console.log(`  [${coin.symbol}] ${tag}perpOpen riallineato al venue: posizione viva (base ${posBase})`);
      }
      const { ready, keep } = matureTranches(st.perpTranches, mark, coin.side, coin.leverage, prof.triggerPct);
      const closeBase = Math.min(ready.reduce((a, t) => a + t.base, 0), posBase);
      if (ready.length && closeBase >= (mkt.minBaseUnits || 1)) {
        const wantRealized = realizedFromTranches(ready, mark, coin.side, mkt.sizeDec);
        if (sim) {
          console.log(`  [${coin.symbol}] ${tag}TAKE-PROFIT (${coin.riskProfile || config.DEFAULT_RISK}): chiuderei ${ready.length} tranche (base ${closeBase}), realizzerei ~$${wantRealized.toFixed(2)}`);
        } else {
          await lighter.close({ accountIndex, marketIndex, baseAmount: closeBase, isAsk: !isAsk, maxSlippage: config.LIGHTER_MAX_SLIPPAGE, apiPrivKey, apiKeyIndex });
          // Il market order e' IOC: "accettato" NON significa "riempito". Rileggo la
          // posizione e credito solo il fill REALE — altrimenti il withdraw dello
          // step 8 preleverebbe margine invece di profitto.
          const filledBase = await closedBaseAfter(accountIndex, marketIndex, coin.side, mkt.sizeDec, posBase, closeBase);
          const fillFrac = closeBase > 0 ? Math.max(0, Math.min(1, filledBase / closeBase)) : 0;
          const realized = wantRealized * fillFrac;
          // tolgo dalle mature solo la size effettivamente chiusa (dalla piu' vecchia)
          st.perpTranches = removeClosedBase([...ready].sort((a, b) => a.ts - b.ts), filledBase).concat(keep);
          if (!st.perpTranches.length) st.perpOpen = false;
          st.perpRealizedUsd += Math.max(0, realized); checkpoint();
          const pct = Math.round(fillFrac * 100);
          console.log(`  [${coin.symbol}] TAKE-PROFIT (${coin.riskProfile || config.DEFAULT_RISK}): chiusa base ${filledBase}/${closeBase} (fill ${pct}%), realizzato ~$${realized.toFixed(2)}`);
          if (fillFrac < 0.99) console.log(`  [${coin.symbol}] fill parziale: le tranche residue restano in lista e ritentano al tick dopo`);
        }
      } else if (ready.length && !sim) {
        // mature ma sotto il size-step minimo: restano in lista e si accumulano
        console.log(`  [${coin.symbol}] ${ready.length} tranche mature sotto il min size (${closeBase} < ${mkt.minBaseUnits}): accumulo`);
      }
    }
  }

  // 8) WITHDRAW del profitto realizzato → sub-wallet su 4663 (la riconciliazione
  //    0a lo accredita SOLO all'arrivo reale, matchando il mittente del transfer).
  //    Write-ahead: realized → intent PRIMA della chiamata; su esito ambiguo
  //    (timeout sidecar, crash) lo step 0-pre promuove l'intent a pending senza
  //    mai ritentare l'invio → nessun doppio withdraw possibile.
  if (Number(st.perpRealizedUsd) >= config.PERP_WITHDRAW_FLOOR_USD) {
    const amount = Number(st.perpRealizedUsd);
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}preleverei $${amount.toFixed(2)} di profitto da Lighter → sub-wallet`);
    } else {
      st.perpRealizedUsd = 0; st.perpWithdrawIntentUsd = amount; checkpoint(); // write-ahead
      try {
        await lighter.withdraw({ accountIndex, amount, apiPrivKey, apiKeyIndex });
      } catch (e) {
        // Rifiuto DEFINITIVO dell'API (es. importo sotto il minimo di Lighter):
        // sappiamo che non e' partito nulla → il profitto torna realizzato e si
        // ritentera' quando sara' cresciuto. Su esito AMBIGUO (timeout/crash)
        // l'intent resta e lo step 0-pre lo promuove a pending: mai un doppio prelievo.
        if (e && e.definitive) {
          st.perpWithdrawIntentUsd = 0; st.perpRealizedUsd = amount; checkpoint();
          console.log(`  [${coin.symbol}] withdraw rifiutato da Lighter ($${amount.toFixed(2)}): profitto riaccreditato, si ritenta piu' avanti`);
        }
        throw e;
      }
      st.perpWithdrawIntentUsd = 0;
      st.perpWithdrawPendingUsd = Number(st.perpWithdrawPendingUsd || 0) + amount;
      if (!st.perpWithdrawBlock) { st.perpWithdrawBlock = await provider.getBlockNumber(); st.perpWithdrawScanBlock = st.perpWithdrawBlock - 1; }
      checkpoint();
      console.log(`  [${coin.symbol}] withdraw profitto: $${amount.toFixed(2)} da Lighter → sub-wallet (in arrivo)`);
    }
  }
}

/**
 * Is the process recorded in a lockfile still alive? Pure, so it is testable.
 *
 * A lock written on ANOTHER host (a previous Railway container, whose volume this one now
 * mounts) is stale by construction: a volume is mounted by one container at a time, and PIDs
 * restart from 1 in every container, so `kill(pid, 0)` would find an unrelated live process,
 * very often this very keeper. A lock with OUR pid is stale for the same reason. Otherwise
 * EPERM from kill(pid, 0) means alive (another user's process), anything else means dead.
 */
function lockHolderAlive(lock, { pid = process.pid, host = os.hostname(), kill = process.kill.bind(process) } = {}) {
  const lpid = Number(lock && lock.pid);
  if (!(lpid > 0)) return false;
  if (lock.host && lock.host !== host) return false;
  if (lpid === pid) return false;
  try { kill(lpid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// lockfile single-instance: creazione ATOMICA (flag wx) — due keeper avviati
// insieme non possono piu' passare entrambi il check.
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCKFILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCKFILE, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }), { flag: 'wx' });
      const release = () => { try { if (JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCKFILE); } catch {} };
      process.on('exit', release);
      process.on('SIGINT', () => { release(); process.exit(0); });
      process.on('SIGTERM', () => { release(); process.exit(0); });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let lock = null;
      try { lock = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')); } catch { /* file corrotto: trattalo come stantio */ }
      const pid = Number(lock && lock.pid) || 0;
      if (lockHolderAlive(lock)) throw new Error(`un altro keeper e' gia' attivo (pid ${pid}). Chiudilo o cancella ${LOCKFILE} se e' morto male.`);
      console.log(`lockfile stantio (pid ${pid}${lock && lock.host ? ' su ' + lock.host : ''}), lo rilevo`);
      try { fs.unlinkSync(LOCKFILE); } catch { /* perso la corsa con un altro processo: il retry fallira' su EEXIST */ }
    }
  }
  throw new Error('impossibile acquisire il lockfile dopo la rimozione di quello stantio');
}

function validateSplit() {
  const s = config.SPLIT_BPS;
  for (const [k, v] of Object.entries(s)) {
    if (!Number.isInteger(v) || v < 0 || v > 10000) throw new Error(`SPLIT_BPS.${k} fuori range [0,10000]: ${v}`);
  }
  const sum = s.perp + s.creator + s.treasury + s.buyback;
  if (sum !== 10000) throw new Error(`SPLIT_BPS non somma a 10000 (${sum}): config errata`);
  const tp = config.TP_MASTER_SHARE_BPS;
  if (!Number.isInteger(tp) || tp < 0 || tp > 10000) throw new Error(`TP_MASTER_SHARE_BPS fuori range [0,10000]: ${tp}`);
}

/**
 * Le soglie si abbassano per i test e ci si dimentica di rialzarle: e' l'errore
 * banale che manda in produzione un motore che apre posizioni ogni $1.50. Qui il
 * keeper confronta i valori attivi con i default di produzione e lo dice a voce
 * alta all'avvio, invece di lasciare la verifica alla memoria di qualcuno.
 */
const PRODUCTION_DEFAULTS = {
  OPEN_GATE_USD: 20,
  TOPUP_STEP_USD: 20,
  BUYBACK_FLOOR_USD: 25,
  MIN_DEPLOY_USD: 2,
};

function warnIfNotProduction() {
  const diff = Object.entries(PRODUCTION_DEFAULTS)
    .filter(([k, v]) => Number(config[k]) !== v)
    .map(([k, v]) => `${k}=${config[k]} (produzione: ${v})`);
  if (!diff.length) return;
  console.log('┌─ ATTENZIONE: soglie NON di produzione ────────────────────────');
  for (const d of diff) console.log('│  ' + d);
  console.log('│  Rimuovi gli override dal .env prima di andare live.');
  console.log('└───────────────────────────────────────────────────────────────');
}

async function main() {
  validateSplit();
  if (!config.LOCKER) throw new Error('PERPSPAD_LOCKER mancante nel .env');
  if (!config.MASTER_SECRET) throw new Error('PERPSPAD_MASTER_SECRET mancante nel .env');
  // A state dir marked MOVED belongs to a keeper that now runs elsewhere (Railway since
  // 2026-10-04). Two keepers on the same sub-wallets collide on nonces and keep two diverging
  // registries, so a local start from the old state is refused outright.
  const moved = path.join(config.STATE_DIR, 'MOVED.json');
  if (fs.existsSync(moved) && !flag('i-know-the-keeper-moved')) {
    throw new Error(`this state was moved (${moved}): the keeper runs elsewhere now. Do not start it from here.`);
  }
  // primo avvio su un volume nuovo (Railway): il registry arriva dal seed, mai sovrascritto
  require('./lib/stateSeed').applySeed(process.env.PERPSPAD_STATE_SEED);
  checkFingerprint(); // stesso master secret con cui sono stati lockati i sub-wallet?
  acquireLock();
  require('./lib/publicServer').startPublicServer();

  const keeper = keeperWallet();
  const locker = new ethers.Contract(config.LOCKER, LOCKER_ABI, keeper);
  const only = arg('coin', null);
  console.log(`keeper ${keeper.address} | locker ${config.LOCKER} | tick ${config.TICK_MS}ms | lighter:${lighter.mode}${only ? ' | solo ' + only : ''}`);
  warnIfNotProduction();

  do {
    const reg = registry.load();
    const checkpoint = () => registry.save(reg);
    // coin nuove dal router (eventi MultiplyLaunch + metadata IPFS + sink): entrano da sole
    try {
      if (await routerCoins.syncRouterCoins(provider, reg) > 0) registry.save(reg);
      else if (reg.routerScanBlock) registry.save(reg); // persiste comunque il cursore di scansione
    } catch (e) { console.log(`  sync router: ${e.message.slice(0, 120)}`); }
    const coins = reg.coins.filter((c) => !only || c.token.toLowerCase() === only.toLowerCase());
    if (!coins.length) console.log(ts() + ' nessuna coin nel registry');
    for (const coin of coins) {
      const st = reg.state[coin.token.toLowerCase()];
      if (!st) { console.log(`  [${coin.symbol}] stato mancante nel registry, salto`); continue; }
      try { await tickCoin(keeper, locker, coin, st, checkpoint); }
      catch (e) { console.log(`  [${coin.symbol}] ERRORE tick: ${e.message.slice(0, 140)}`); }
      registry.save(reg);
    }
    // estratto pubblico per il sito (senza chiavi API ne' stato interno):
    // in produzione il frontend gira su un host remoto e non vede il file locale
    publish.writeSnapshot(reg);
    if (!flag('once')) await sleep(config.TICK_MS);
  } while (!flag('once'));
}

if (require.main === module) {
  main().catch((e) => { console.error('Errore fatale:', e.message); process.exit(1); });
}

// helper puri esportati per i test a secco
module.exports = { trancheTargetMark, markFromPosition, reconcileTranches, matureTranches, realizedFromTranches, removeClosedBase, addTranche, fundingDelta, quoteExactInV3, coinValueInQuote, isFeeInflow, lockHolderAlive };
