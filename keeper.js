const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const config = require('./config');
const { provider, erc20, priceUsd, usdOf, rawFromUsd, gasPrice } = require('./lib/chain');
const { deriveSubWallet, checkFingerprint } = require('./lib/subwallet');
const { encryptSecret, decryptSecret, isEncrypted } = require('./lib/secrets');
const { buildSwapCalldata } = require('./lib/v3');
const registry = require('./lib/registry');
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
const LOCKFILE = path.resolve(__dirname, 'state', 'keeper.lock');
const Q96 = BN(2).pow(96);

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
  // posBase < sum: funding/riduzioni esterne → scala proporzionale, resto alla piu' grande
  const factor = posBase / sum;
  const scaled = tranches.map((t) => ({ ...t, base: Math.floor(t.base * factor) })).filter((t) => t.base > 0);
  const acc = scaled.reduce((a, t) => a + t.base, 0);
  let rem = posBase - acc;
  if (rem > 0 && scaled.length) {
    let iMax = 0;
    for (let i = 1; i < scaled.length; i++) if (scaled[i].base > scaled[iMax].base) iMax = i;
    scaled[iMax].base += rem;
  }
  return { tranches: scaled, changed: true, note: `tranche riscalate a ${posBase} unita' (contabilita' era ${sum})` };
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

// output ESATTO di un exact-in swap V3 in un range a liquidita' costante (i pool
// perpspad sono a posizione singola one-sided → L costante nel range: esatto).
// Formule canoniche SqrtPriceMath, identiche a uniQuote.js del repo.
function quoteExactInV3(sqrtP, L, amountInNet, zeroForOne) {
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
async function buybackMinOut(coin, quoteIs0, spendRaw) {
  const pool = new ethers.Contract(coin.pool, POOL_ABI, provider);
  const [{ sqrtPriceX96 }, L] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const net = spendRaw.mul(1000000 - coin.fee).div(1000000); // fee presa sull'input
  const out = quoteExactInV3(sqrtPriceX96, L, net, quoteIs0); // quote in = token0 ⇔ zeroForOne
  return out.mul(10000 - config.BUYBACK_MAX_SLIPPAGE_BPS).div(10000);
}

async function tickCoin(keeper, locker, coin, st, checkpoint) {
  const token = coin.token;
  const sub = deriveSubWallet(token, provider);
  const quoteIs0 = BN(coin.pair).lt(BN(token));
  const unitUsd = priceUsd(coin.pair, coin.pairSymbol);
  const quote = erc20(coin.pair);
  const coinC = erc20(token);

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
        if (String(ev.args.from).toLowerCase() !== coin.pool.toLowerCase()) bridgedRaw = bridgedRaw.add(ev.args.value);
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

  // ── 1. CLAIM: decidi con la static, misura col delta reale ──────────────────
  let est;
  try { const [a0, a1] = await locker.callStatic.collect(coin.lpTokenId); est = quoteIs0 ? a0 : a1; }
  catch (e) { console.log(`  [${coin.symbol}] static collect fallita: ${e.message.slice(0, 80)}`); return; }

  if (usdOf(est, coin.pairDecimals, unitUsd) >= config.CLAIM_MIN_USD) {
    const quoteBefore = await quote.balanceOf(sub.address);
    await send(keeper, { to: config.LOCKER, data: locker.interface.encodeFunctionData('collect', [coin.lpTokenId]), gasLimit: 300000 }, 'collect');
    const realQuote = (await quote.balanceOf(sub.address)).sub(quoteBefore); // fee quote REALMENTE incassate
    st.totalCollected0 = BN(st.totalCollected0).add(realQuote).toString();

    // ── 2. SPLIT (resto al perp: somma esatta) ───────────────────────────────
    const creatorCut = realQuote.mul(config.SPLIT_BPS.creator).div(10000);
    const treasuryCut = realQuote.mul(config.SPLIT_BPS.treasury).div(10000);
    const buybackCut = realQuote.mul(config.SPLIT_BPS.buyback).div(10000);
    const perpCut = realQuote.sub(creatorCut).sub(treasuryCut).sub(buybackCut);
    st.perpReserveRaw = BN(st.perpReserveRaw).add(perpCut).toString();
    st.creatorOwedRaw = BN(st.creatorOwedRaw).add(creatorCut).toString();
    st.treasuryOwedRaw = BN(st.treasuryOwedRaw).add(treasuryCut).toString();
    st.buybackReserveRaw = BN(st.buybackReserveRaw).add(buybackCut).toString();
    checkpoint(); // stato coerente con la collect gia' avvenuta
    console.log(`  [${coin.symbol}] claim: ${ethers.utils.formatUnits(realQuote, coin.pairDecimals)} ${coin.pairSymbol} ($${usdOf(realQuote, coin.pairDecimals, unitUsd).toFixed(2)})`);
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
    const allowance = await quote.allowance(sub.address, config.SWAP_ROUTER);
    if (allowance.lt(spendRaw)) {
      await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('approve', [config.SWAP_ROUTER, ethers.constants.MaxUint256]), gasLimit: 80000 }, 'approve router');
    }
    const minOut = await buybackMinOut(coin, quoteIs0, spendRaw);
    const before = await coinC.balanceOf(sub.address);
    st.buybackReserveRaw = BN(st.buybackReserveRaw).sub(spendRaw).toString(); checkpoint(); // decremento prima dell'invio
    // Il try copre SOLO lo swap: se fallisce lui, gli USDG non sono usciti e la
    // riserva si puo' ripristinare. Misura e burn stanno fuori — un loro errore
    // dopo uno swap riuscito non deve MAI ri-accreditare USDG gia' spesi (il
    // saldo coin resta nel sub-wallet e lo brucia lo step 3 al tick dopo).
    let swapped = false;
    try {
      const data = buildSwapCalldata({ tokenIn: coin.pair, tokenOut: token, fee: coin.fee, recipient: sub.address, amountIn: spendRaw, amountOutMinimum: minOut });
      await send(sub, { to: config.SWAP_ROUTER, data, gasLimit: 400000 }, 'buyback swap');
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

  // 6) OPEN / TOPUP: deploya il collaterale libero al leverage scelto.
  //    Il profitto gia' REALIZZATO (perpRealizedUsd) resta fuori dal deployable:
  //    e' in coda per il withdraw (step 8) e non va ri-lockato in posizione —
  //    altrimenti dopo una chiusura totale (profilo safe) il withdraw fallirebbe.
  const deployableUsd = Math.max(0, freeCollateralUsd - Number(st.perpRealizedUsd || 0));
  if (deployableUsd >= 1) {
    const wasOpen = st.perpOpen;
    const notionalUsd = deployableUsd * coin.leverage;
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}perp ${wasOpen ? 'topup' : 'open'}: aprirei notional $${notionalUsd.toFixed(2)} ${coin.side} ${coin.leverage}x (deployable $${deployableUsd.toFixed(2)}, riservato al withdraw $${Number(st.perpRealizedUsd || 0).toFixed(2)})`);
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
        if (r.mark) {
          st.perpTranches.push({ base: filled, entryMark: Number(r.mark), collateralUsd: usedCollateralUsd, sizeDec: mkt.sizeDec, ts: Date.now() });
          // la `pos` letta allo step 5 e' PRECEDENTE a quest'ordine: senza tenerne
          // conto la riconciliazione dello step 7 vedrebbe le tranche "in eccesso"
          // e le riscalerebbe tutte (proprio la diluizione che le tranche evitano).
          openedBaseThisTick += filled;
        }
        checkpoint();
        console.log(`  [${coin.symbol}] perp ${wasOpen ? 'topup' : 'open'}: notional $${notionalUsd.toFixed(2)} ${coin.side} ${coin.leverage}x (fill ${filled}/${r.baseAmount} @ ${r.mark})`);
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
        if (!rec.tranches.length) st.perpOpen = false;
        if (!sim) checkpoint();
        if (rec.note) console.log(`  [${coin.symbol}] ${tag}tranches: ${rec.note}`);
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

// lockfile single-instance: creazione ATOMICA (flag wx) — due keeper avviati
// insieme non possono piu' passare entrambi il check. EPERM su kill(pid, 0)
// significa processo VIVO di un altro utente, non morto.
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCKFILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCKFILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      const release = () => { try { if (JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCKFILE); } catch {} };
      process.on('exit', release);
      process.on('SIGINT', () => { release(); process.exit(0); });
      process.on('SIGTERM', () => { release(); process.exit(0); });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')).pid); } catch { /* file corrotto: trattalo come stantio */ }
      let alive = false;
      try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (err) { alive = err.code === 'EPERM'; }
      if (alive) throw new Error(`un altro keeper e' gia' attivo (pid ${pid}). Chiudilo o cancella ${LOCKFILE} se e' morto male.`);
      console.log(`lockfile stantio (pid ${pid} morto), lo rilevo`);
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

async function main() {
  validateSplit();
  if (!config.LOCKER) throw new Error('PERPSPAD_LOCKER mancante nel .env');
  if (!config.MASTER_SECRET) throw new Error('PERPSPAD_MASTER_SECRET mancante nel .env');
  checkFingerprint(); // stesso master secret con cui sono stati lockati i sub-wallet?
  acquireLock();

  const keeper = keeperWallet();
  const locker = new ethers.Contract(config.LOCKER, LOCKER_ABI, keeper);
  const only = arg('coin', null);
  console.log(`keeper ${keeper.address} | locker ${config.LOCKER} | tick ${config.TICK_MS}ms | lighter:${lighter.mode}${only ? ' | solo ' + only : ''}`);

  do {
    const reg = registry.load();
    const checkpoint = () => registry.save(reg);
    const coins = reg.coins.filter((c) => !only || c.token.toLowerCase() === only.toLowerCase());
    if (!coins.length) console.log(ts() + ' nessuna coin nel registry');
    for (const coin of coins) {
      const st = reg.state[coin.token.toLowerCase()];
      if (!st) { console.log(`  [${coin.symbol}] stato mancante nel registry, salto`); continue; }
      try { await tickCoin(keeper, locker, coin, st, checkpoint); }
      catch (e) { console.log(`  [${coin.symbol}] ERRORE tick: ${e.message.slice(0, 140)}`); }
      registry.save(reg);
    }
    if (!flag('once')) await sleep(config.TICK_MS);
  } while (!flag('once'));
}

if (require.main === module) {
  main().catch((e) => { console.error('Errore fatale:', e.message); process.exit(1); });
}

// helper puri esportati per i test a secco
module.exports = { trancheTargetMark, markFromPosition, reconcileTranches, matureTranches, realizedFromTranches, removeClosedBase, quoteExactInV3 };
