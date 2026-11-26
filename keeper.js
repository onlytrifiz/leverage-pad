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
const { flywheelTick } = require('./lib/flywheel');
const { createFeed, createUrgent } = require('./lib/marketFeed');
const { createLanes, createMutex } = require('./lib/lanes');
const { createStore } = require('./lib/store');
const { multicall } = require('./lib/multicall');
const routerCoins = require('./lib/routerCoins');
const { legacyTakeProfitPct } = require('./lib/launchParams');
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
 *    sub-wallet una volta sola e poi FLUSHA (25% treasury / 70% sub-wallet, 15/80 per le coin fino al 2026-11-25, dentro il
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
  // a quarter above the last price: between the read and the send the base fee may rise, and a price
  // under it is refused. What is paid is the base fee either way.
  const gp = (await gasPrice()).mul(5).div(4);
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

/**
 * The receipt of a transaction that has been sent, whatever the node does meanwhile: a read that
 * fails is read again, and only a receipt ends it. Past the timeout it is unknown: stuck.
 */
async function receiptOf(prov, hash, label, ms = config.WAIT_TIMEOUT_MS) {
  const until = Date.now() + ms;
  for (let wait = 250; ; wait = Math.min(1_500, wait * 2)) {
    let rc = null;
    try { rc = await prov.getTransactionReceipt(hash); } catch { /* not now */ }
    if (rc && rc.blockNumber != null) return rc;
    if (Date.now() + wait > until) throw new StuckTxError(label, hash, ms);
    await sleep(wait);
  }
}

// Tokens work side by side, but a wallet has one sequence of nonces: its transactions go one after
// the other, each mined before the next is numbered.
const oneAtATime = createMutex();
const send = (wallet, tx, label, onSigned) => oneAtATime(wallet.address.toLowerCase(), () => sendNow(wallet, tx, label, onSigned));
/** a wallet held this long is waiting for a transaction that may not come: whoever can, does without */
const walletStuck = (wallet) => oneAtATime.heldFor(wallet.address.toLowerCase()) > 10_000;

/**
 * The node's own words for a transaction it will not take: anything else is no answer at all.
 * "Nonce too low" is not among them: it is also what a second copy of a transaction already mined
 * is told, and a node a block behind would not know the first.
 */
const REFUSALS = /insufficient funds|max fee per gas less than block base fee|fee cap less than|intrinsic gas too low|exceeds block gas limit|nonce too high|replacement transaction underpriced|transaction underpriced|invalid (sender|signature|chain id)|transaction type not supported|execution reverted|gas required exceeds/i;
function refusedByNode(e) {
  if (['INSUFFICIENT_FUNDS', 'REPLACEMENT_UNDERPRICED'].includes(e.code)) return true;
  for (const x of [e, e.error, e.error && e.error.error]) {
    if (!x) continue;
    let body = null;
    try { body = JSON.parse(x.body); } catch { /* not JSON */ }
    if (body && body.error && REFUSALS.test(String(body.error.message))) return true;
  }
  return false;
}

/** hands a signed transaction to the node; an answer that never comes is not waited for long */
async function broadcast(prov, raw) {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('no answer to the broadcast')), config.BROADCAST_TIMEOUT_MS); });
  try { await Promise.race([prov.sendTransaction(raw), late]); } finally { clearTimeout(timer); }
}

/**
 * Signs, records, sends, and waits. `onSigned({ raw, hash, nonce })` runs before anything leaves:
 * whoever moves money writes it down there (see `moving`). Throws StuckTxError when the outcome is
 * not known; any other error means the transaction did not and cannot happen, or was reverted.
 */
async function sendNow(wallet, tx, label, onSigned) {
  // Su Arbitrum Orbit il costo di posting L1 e' addebitato come UNITA' di gas
  // extra: i limiti fissi (21000 in testa) sono insufficienti. Stima reale con
  // margine 30%; se la stima fallisce (hiccup RPC) si ripiega sul limite fornito.
  // Il gasLimit di fallback NON va passato a estimateGas: il nodo lo userebbe
  // come tetto e la stima fallirebbe proprio quando serve di piu' (misurato:
  // collect del locker = 323k contro un fallback di 300k).
  const { gasLimit: fallbackLimit, ...estTx } = tx;
  let gasLimit = fallbackLimit;
  try { gasLimit = (await wallet.estimateGas(estTx)).mul(13).div(10); } catch { /* fallback al limite fornito */ }
  const req = await wallet.populateTransaction({ gasPrice: await cappedGasPrice(), type: 0, ...tx, gasLimit });
  const raw = await wallet.signTransaction(req), hash = ethers.utils.keccak256(raw);
  if (onSigned) onSigned({ raw, hash, nonce: Number(req.nonce) });
  let usedNonce = false;
  try { await broadcast(wallet.provider, raw); }
  catch (e) {
    // a gateway may have retried it, and a refusal may be of the second copy: the chain is asked first
    let seen = true;
    try { seen = !!(await wallet.provider.getTransaction(hash)); } catch { /* unknown: as if it were in */ }
    if (!seen && refusedByNode(e)) throw e;
    usedNonce = e.code === 'NONCE_EXPIRED' || /nonce too low/i.test(`${e.message} ${e.body}`);
  }
  const rc = await receiptOf(wallet.provider, hash, label, usedNonce ? Math.min(20_000, config.WAIT_TIMEOUT_MS) : config.WAIT_TIMEOUT_MS);
  if (rc.status !== 1) throw new Error(label + ' revertata: ' + hash);
  return rc;
}

// ── money on its way ────────────────────────────────────────────────────────
// A transfer out of a token's wallet is in its state from before it leaves until it is known: the
// bucket it was taken from, and the signed transaction itself. Meanwhile nothing else leaves that
// wallet and nothing in it is taken for something else. After a crash or a node that does not
// answer, the SAME transaction is sent again: by its nonce it can happen once, whoever repeats it.

/** takes `raw` out of `bucket` and sends it; throws like send(), with the books already right */
async function moving({ st, checkpoint, wallet, bucket, raw, tx, label, onDone, extra }) {
  st.txOut = { bucket, amountRaw: raw.toString(), label, ...(extra ? { extra } : {}) };
  st[bucket] = BN(st[bucket] || '0').sub(raw).toString(); checkpoint();
  let rc;
  try { rc = await send(wallet, tx, label, (signed) => { Object.assign(st.txOut, signed, { at: Date.now() }); checkpoint(); }); }
  catch (e) {
    if (!isStuck(e)) { giveBack(st); checkpoint(); }
    throw e;
  }
  if (onDone) onDone(rc);
  st.txOut = null; checkpoint();
  return rc;
}
function giveBack(st) {
  const t = st.txOut;
  st[t.bucket] = BN(st[t.bucket] || '0').add(t.amountRaw).toString();
  if (t.extra && t.extra.perpDepositAt != null) st.perpDepositAt = t.extra.perpDepositAt;
  st.txOut = null;
}

/** what came of the transfer in flight; false while it is not known */
async function settleTxOut({ coin, st, checkpoint, wallet, keeper }) {
  const t = st.txOut;
  if (!t) return true;
  const done = (msg) => { checkpoint(); console.log(`  [${coin.symbol}] ${t.label}: ${msg}`); return true; };
  if (!t.hash) { giveBack(st); return done('never left, given back'); }
  const prov = wallet.provider;
  const rc = await prov.getTransactionReceipt(t.hash);
  if (rc && rc.blockNumber != null) {
    if (rc.status !== 1) { giveBack(st); return done('reverted, given back'); }
    if (t.extra && t.extra.depositedUsd) st.perpDepositedUsd = Number(st.perpDepositedUsd || 0) + t.extra.depositedUsd;
    st.txOut = null;
    return done(`confirmed ${t.hash}`);
  }
  const latest = await prov.getTransactionCount(wallet.address, 'latest');
  if (latest > t.nonce) {
    // the nonce is used and not by it. Two looks a minute apart: nodes do not all see the same head
    if (!t.usedAt) { t.usedAt = Date.now(); checkpoint(); return false; }
    if (Date.now() - t.usedAt < 60_000) return false;
    giveBack(st);
    return done('another transaction took its place, given back');
  }
  try { await broadcast(prov, t.raw); } catch { /* it has it already, or will have it next time */ }
  if (Date.now() - t.at > config.TX_GIVE_UP_MS) {
    // A price nobody takes any more, or a nonce before it that nobody used: the first free one is
    // used for nothing, pass after pass up to its own, and then it is known.
    try {
      if (keeper) await ensureGas(keeper, wallet.address);
      await wallet.sendTransaction({ to: wallet.address, value: 0, nonce: latest, gasPrice: await cappedGasPrice(), gasLimit: 100_000, type: 0 });
    } catch { /* one of the two goes in, or the next pass tries again */ }
  }
  return false;
}

// il sub-wallet paga gas per burn/payout/swap: il keeper lo tiene rifornito.
// Floor e top-up dal gasPrice CAPPATO (non manipolabile oltre il cap).
async function ensureGas(keeper, subAddr) {
  const gp = await cappedGasPrice();
  const floor = gp.mul(config.GAS_TICK_UNITS);
  const bal = await provider.getBalance(subAddr);
  if (bal.gte(floor)) return;
  if (walletStuck(keeper)) throw new Error('the keeper wallet is waiting for a transaction: no gas top-up now');
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
// Ogni deposito/topup e' una tranche {base, entryMark, collateralUsd, sizeDec, ts, leverage}.
// `leverage` is the leverage set on the venue when the tranche was opened (absent on tranches
// recorded before the engine could change: they fall back to the coin's leverage).
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
    last.collateralUsd = (last.collateralUsd || 0) + (t.collateralUsd || 0);
    // age weighted like the entry: a splinter must not restart the take-profit decay clock of
    // the tranche it joins. The leverage stays the existing tranche's.
    if (last.ts != null && t.ts != null) last.ts = Math.round((last.ts * last.base + t.ts * t.base) / total);
    else last.ts = last.ts ?? t.ts;
    last.base = total;
    return { tranches, merged: true };
  }
  tranches.push(t);
  return { tranches, merged: false };
}

const DAY_MS = 86_400_000;

/**
 * The take-profit of a tranche of age `ageMs`, as a fraction (0.5 = +50% on its collateral).
 * Unchanged for TP_DECAY_START_DAYS, then lowered linearly to the floor at TP_DECAY_END_DAYS,
 * and held there. A trigger already at or below the floor never moves: the decay only ever
 * makes a target easier to reach, never harder.
 */
function effectiveTrigger(triggerFrac, ageMs, cfg = config) {
  const floor = Math.min(triggerFrac, cfg.TP_DECAY_FLOOR_PCT / 100);
  if (!(triggerFrac > floor)) return triggerFrac;
  const start = cfg.TP_DECAY_START_DAYS * DAY_MS, end = cfg.TP_DECAY_END_DAYS * DAY_MS;
  if (!(ageMs > start)) return triggerFrac;
  if (ageMs >= end || end <= start) return floor;
  return triggerFrac - (triggerFrac - floor) * (ageMs - start) / (end - start);
}

// the coin's take-profit as a fraction: the on-chain percent, or the legacy profile's
const coinTrigger = (coin) => (coin.takeProfitPct ?? legacyTakeProfitPct(coin.riskProfile)) / 100;

// separa le tranche mature (target raggiunto) da quelle ancora in corsa. Each tranche runs at
// its own leverage and its own (decayed) trigger; `leverage` is the fallback for tranches that
// predate per-tranche leverage.
function matureTranches(tranches, mark, side, leverage, triggerPct, nowMs = Date.now()) {
  const ready = [], keep = [];
  for (const t of tranches) {
    const trigger = effectiveTrigger(triggerPct, nowMs - (t.ts ?? nowMs));
    const target = trancheTargetMark(t.entryMark, side, t.leverage ?? leverage, trigger);
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

// ── managed coins: the engine's market or side can change under an open position ─────

/** Open positions the coin's current engine does not own: another market, or the other side. */
function strayPositions(positions, marketIndex, side) {
  const want = side === 'short' ? -1 : 1;
  return (positions || []).filter((p) => {
    if (!(Math.abs(Number(p.size)) > 0)) return false;
    if (marketIndex == null || Number(p.market_id) !== Number(marketIndex)) return true;
    return p.sign != null && Number(p.sign) !== want;
  });
}

/** a leftover the venue refused to close for being too small, and not grown since */
const isDust = (st, p) => st.perpDust != null && Math.abs(Number(p.size)) <= Number(st.perpDust[p.market_id] ?? -1);

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
    // A slot the venue keeps for a closed position (size 0, no cumulative). Its baseline goes:
    // reading it as "0 paid" would hand back as profit all the funding the closed one had paid.
    if (p.size != null && Number(p.size) === 0) continue;
    const cum = p.total_funding_paid_out == null ? NaN : Number(p.total_funding_paid_out);
    // campo assente (API vecchia o mercato senza funding): la baseline si conserva
    // com'e', cosi' un buco temporaneo nella risposta non si traduce in un delta.
    if (!isFinite(cum)) {
      if (prev[mid] !== undefined) next[mid] = prev[mid];
      continue;
    }
    // The first reading of a position is where counting starts, whatever it says: after a close
    // the venue's counter restarts from zero or carries on with what is already in the books
    // (seen live: BTC short closed and reopened, the same +0.005598 read again and paid twice).
    if (prev[mid] !== undefined) delta += cum - Number(prev[mid]);
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

  if (walletStuck(keeper)) return; // the fees wait in the sink, the rest of the token does not
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

/**
 * USDG in the wallet that no bucket knows goes to the engine, and a bucket the wallet cannot cover
 * is brought down to it. A node a block behind shows either for a moment: a surplus is believed
 * when it is there twice, and only as much as both times; a hole when it has been there a while.
 */
function sweepSurplus({ coin, st, checkpoint, real, accounted, unitUsd, now = Date.now() }) {
  const usd = (raw) => usdOf(raw, coin.pairDecimals, unitUsd);
  const surplus = real.gt(accounted) ? real.sub(accounted) : BN(0);
  if (usd(surplus) >= config.CLAIM_MIN_USD) {
    st.shortSince = 0;
    const seen = st.surplusSeen;
    if (!seen) { st.surplusSeen = { raw: surplus.toString(), at: now }; checkpoint(); return; }
    if (now - seen.at < config.SEEN_AGAIN_MS) return;
    const both = surplus.lt(seen.raw) ? surplus : BN(seen.raw);
    st.surplusSeen = null;
    st.perpReserveRaw = BN(st.perpReserveRaw).add(both).toString();
    checkpoint();
    console.log(`  [${coin.symbol}] sweep: $${usd(both).toFixed(2)} non attribuiti → perp reserve`);
    return;
  }
  if (st.surplusSeen) { st.surplusSeen = null; checkpoint(); }
  const short = accounted.gt(real) ? accounted.sub(real) : BN(0);
  if (usd(short) < 0.01) { if (st.shortSince) { st.shortSince = 0; checkpoint(); } return; }
  if (!st.shortSince) { st.shortSince = now; checkpoint(); return; }
  if (now - st.shortSince < config.SHORT_BELIEVED_MS) return;
  const off = short.lt(st.perpReserveRaw) ? short : BN(st.perpReserveRaw);
  st.shortSince = 0;
  st.perpReserveRaw = BN(st.perpReserveRaw).sub(off).toString();
  checkpoint();
  console.log(`  [${coin.symbol}] the wallet holds $${usd(short).toFixed(2)} less than the books: $${usd(off).toFixed(2)} taken off the perp reserve`);
}

async function tickCoin(keeper, locker, coin, st, checkpoint) {
  const token = coin.token;
  const sub = deriveSubWallet(token, provider);
  const quoteIs0 = BN(coin.pair).lt(BN(token));
  const unitUsd = priceUsd(coin.pair, coin.pairSymbol);
  const quote = erc20(coin.pair);
  const coinC = erc20(token);

  if (config.PAUSED.has(token.toLowerCase())) { st.lastTickTs = Date.now(); return; }

  if (config.RETIRED.has(token.toLowerCase())) {
    await retireTick(keeper, coin, st, checkpoint, sub, unitUsd, quote);
    st.lastTickTs = Date.now();
    return;
  }

  // una coin lanciata con metadata non validi non ha un motore: le sue fee restano
  // visibili nel sink e nessuna posizione viene mai aperta (niente da servire)
  if (coin.engineError) {
    logOnce(st, 'engineErrorLogged', checkpoint, `  [${coin.symbol}] motore non configurabile (${coin.engineError}): coin non servita`);
    return;
  }

  // money already on its way out of this wallet comes first: until it is known nothing else leaves
  // it and nothing in it is counted. The position does not wait for it.
  let known = false;
  try { known = await settleTxOut({ coin, st, checkpoint, wallet: sub, keeper }); }
  catch (e) { console.log(`  [${coin.symbol}] ${st.txOut.label}: not readable now (${e.message.slice(0, 80)})`); }
  if (!known) {
    if (lighter.enabled) {
      try { await perpTick(keeper, coin, st, checkpoint, sub, unitUsd, quote, { urgent: true }); }
      catch (e) { console.log(`  [${coin.symbol}] perp: ${e.message.slice(0, 140)}`); }
    }
    st.lastTickTs = Date.now();
    return;
  }

  // ── 0-pre. WITHDRAW con esito ambiguo da un run precedente: promuovi a pending ─
  // Il write-ahead dello step 8 lascia perpWithdrawIntentUsd > 0 se il processo e'
  // morto (o il sidecar e' andato in timeout) DOPO l'invio ma prima della conferma.
  // Trattarlo come inviato e' la scelta sicura: se il withdraw non e' mai partito,
  // il pending resta li' senza credito (0a accredita solo USDG arrivati davvero).
  // An intent that knows the cash it was sent from is settled on it, in perpTick.
  if (Number(st.perpWithdrawIntentUsd) > 0 && st.perpWithdrawCashUsd == null) {
    const amt = Number(st.perpWithdrawIntentUsd);
    intentToPending(st);
    if (!st.perpWithdrawBlock) { st.perpWithdrawBlock = await provider.getBlockNumber(); st.perpWithdrawScanBlock = st.perpWithdrawBlock - 1; }
    checkpoint();
    console.log(`  [${coin.symbol}] withdraw con esito ambiguo ($${amt.toFixed(2)}): trattato come inviato — verra' accreditato solo all'arrivo reale`);
  }

  // What is done on the chain, step by step: one that fails is tried again at the next round, and
  // the position is looked after whatever happened here.
  try { await chainSteps({ keeper, locker, coin, st, checkpoint, sub, unitUsd, quote, quoteIs0, coinC }); }
  catch (e) { console.log(`  [${coin.symbol}] chain: ${e.message.slice(0, 140)}`); }

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

async function chainSteps({ keeper, locker, coin, st, checkpoint, sub, unitUsd, quote, quoteIs0, coinC }) {
  const token = coin.token;
  // ── 0a. WITHDRAW: credito SOLO dagli USDG davvero arrivati dal bridge ────────
  // Match per MITTENTE, non per surplus aggregato: gli inflow dal pool sono fee,
  // qualunque altro inflow durante la finestra del withdraw e' il settlement.
  // Cosi' fee incassate da collect() esterne o fondi orfani non vengono piu'
  // scambiati per profitto, e il profitto vero non resta orfano.
  // While another is still being settled nobody looks: what arrives could be either's, and the
  // cursor would pass over the second.
  let seenTo = null; // the last block whose arrivals have been credited
  if (Number(st.perpWithdrawPendingUsd) > 0 && !(Number(st.perpWithdrawIntentUsd) > 0)) {
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
      seenTo = latest;
      if (creditRaw.gt(0) && usdOf(creditRaw, coin.pairDecimals, unitUsd) >= config.CLAIM_MIN_USD) {
        const pendingUsd = Number(st.perpWithdrawPendingUsd), pendingProfitUsd = Number(st.perpWithdrawPendingProfitUsd || 0);
        const { toTreasury, toBuyback } = splitArrival(creditRaw, pendingUsd, pendingProfitUsd);
        st.buybackReserveRaw = BN(st.buybackReserveRaw).add(toBuyback).toString();
        st.treasuryOwedRaw = BN(st.treasuryOwedRaw).add(toTreasury).toString();
        st.perpWithdrawPendingUsd = Math.max(0, pendingUsd - usdOf(creditRaw, coin.pairDecimals, unitUsd));
        st.perpWithdrawPendingProfitUsd = pendingProfitUsd * (st.perpWithdrawPendingUsd / pendingUsd);
        if (st.perpWithdrawPendingUsd < 0.01) { st.perpDoubtUsd = 0; st.perpWithdrawPendingUsd = 0; st.perpWithdrawPendingProfitUsd = 0; st.perpWithdrawBlock = null; st.perpWithdrawScanBlock = null; }
        console.log(`  [${coin.symbol}] rientrato dal bridge: $${usdOf(creditRaw, coin.pairDecimals, unitUsd).toFixed(2)} → $${usdOf(toBuyback, coin.pairDecimals, unitUsd).toFixed(2)} buyback / $${usdOf(toTreasury, coin.pairDecimals, unitUsd).toFixed(2)} treasury`);
      }
      checkpoint(); // persiste comunque lo scanBlock (mai ricontare gli stessi log)
    }
  }

  // ── 0b. SWEEP: surplus non attribuito → perp reserve ────────────────────────
  // Qualunque USDG del sub-wallet oltre i bucket noti (fee incassate da collect()
  // esterne, fondi rimasti orfani da un crash, invii di terzi) torna a lavorare
  // nel motore. Con lo split 100% perp e' anche la destinazione naturale.
  if (!(Number(st.perpWithdrawIntentUsd) > 0) && (seenTo != null || !(Number(st.perpWithdrawPendingUsd) > 0))) {
    const accounted = BN(st.buybackReserveRaw).add(st.creatorOwedRaw).add(st.treasuryOwedRaw).add(st.perpReserveRaw);
    // while a withdrawal is on its way the balance is read where its arrivals were looked for:
    // one that landed since would be swept now and credited again at the next tick
    const real = await quote.balanceOf(sub.address, ...(seenTo != null ? [{ blockTag: seenTo }] : []));
    sweepSurplus({ coin, st, checkpoint, real, accounted, unitUsd });
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
    await moving({ st, checkpoint, wallet: sub, bucket, raw: owed, label: `payout ${label}`, tx: { to: coin.pair, data: quote.interface.encodeFunctionData('transfer', [dest, owed]), gasLimit: 100000 } });
    console.log(`  [${coin.symbol}] payout ${label}: ${ethers.utils.formatUnits(owed, coin.pairDecimals)} ${coin.pairSymbol} → ${dest}`);
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
    // Il try copre SOLO lo swap: se fallisce lui, gli USDG non sono usciti e la
    // riserva si puo' ripristinare. Misura e burn stanno fuori — un loro errore
    // dopo uno swap riuscito non deve MAI ri-accreditare USDG gia' spesi (il
    // saldo coin resta nel sub-wallet e lo brucia lo step 3 al tick dopo).
    let swapped = false;
    try {
      await moving({ st, checkpoint, wallet: sub, bucket: 'buybackReserveRaw', raw: spendRaw, label: 'buyback swap', tx: { to: plan.to, data: plan.data, gasLimit: plan.gasLimit } });
      swapped = true;
    } catch (e) {
      if (!isStuck(e)) {
        console.log(`  [${coin.symbol}] buyback fallito (slippage?), riprovo al tick dopo: ${e.message.slice(0, 80)}`);
      } else {
        console.log(`  [${coin.symbol}] buyback in viaggio (${e.hash}): l'esito al prossimo giro`);
        return; // nothing else leaves this wallet until it is known
      }
    }
    if (swapped) {
      const bought = (await coinC.balanceOf(sub.address)).sub(before);
      await burnCoin(sub, token, bought, st);
      checkpoint();
      console.log(`  [${coin.symbol}] BUYBACK&BURN: $${spendUsd.toFixed(2)} → ${ethers.utils.formatEther(bought)} ${coin.symbol} bruciati (minOut ${ethers.utils.formatEther(minOut)})`);
    }
  }
}

/** a client order index no other order of the account has: its trades are found by it */
let lastOrderId = 0;
const orderId = () => (lastOrderId = Math.max(Date.now(), lastOrderId + 1));

const pause = () => new Promise((r) => setTimeout(r, config.LIGHTER_FILL_RETRY_MS));
const isolatedCash = (acc) => Number(acc.collateral ?? acc.available_balance ?? 0);

/**
 * What a close took out of the engine, in USD, as the venue pays it: the margin of the part closed
 * and its result against the position's AVERAGE entry. A tranche decides when and how much to close
 * by its own entry, but Lighter holds one netted position and that is the cash it releases; the
 * difference stays in the position and comes out with the tranches that are left.
 */
function closeProceeds({ filled, base, price, avgEntry, margin, side, sizeDec }) {
  const pnl = (side === 'short' ? avgEntry - price : price - avgEntry) * filled / 10 ** sizeDec;
  return { pnl, profit: Math.max(0, pnl), capital: Math.max(0, margin * filled / base + Math.min(0, pnl)) };
}

/** the order in flight, on disk before it is sent: a crash or a timeout loses nothing of it */
function recordOrder(st, checkpoint, o) {
  st.perpOrder = { id: orderId(), at: Date.now(), sent: false, ...o };
  checkpoint();
  return st.perpOrder;
}

/**
 * Settles the order in flight on what it TRADED, found by its index: the only answer that is the
 * same before and after a crash, a timeout or a stale read. Until it is known nothing else touches
 * the account. An IOC is over in seconds: short of what was asked it is believed after a while, and
 * one whose sending is unknown after its own expiry. Returns false while still unknown.
 */
async function settleOrder({ coin, st, checkpoint, accountIndex, tries = 1 }) {
  const o = st.perpOrder;
  if (!o) return true;
  for (let i = 0; i < tries; i++) {
    if (i) await pause();
    let f = null, acc;
    try { f = await lighter.fills({ accountIndex, marketIndex: o.marketIndex, clientOrderIndex: o.id, since: o.at }); } catch { /* unknown */ }
    // the whole order in its own trades: there is nothing the account could add
    if (f && o.ask != null && Number(f.price) > 0 && Math.round(Number(f.size) * 10 ** o.sizeDec) >= o.ask) {
      st.perpOrder = null;
      bookOrder(coin, st, o, o.ask, Number(f.price));
      checkpoint();
      return true;
    }
    try { acc = await lighter.account(accountIndex); } catch { continue; }
    const age = Date.now() - o.at;
    const late = age >= 2 * config.LIGHTER_ORDER_EXPIRY_MS;
    if (!f && !late) continue;
    const price = f ? Number(f.price) : NaN;
    const traded = price > 0 ? Math.min(Math.round(Number(f.size) * 10 ** o.sizeDec), o.ask ?? Infinity) : 0;
    const p = (acc.positions || []).find((x) => Number(x.market_id) === Number(o.marketIndex));
    const here = p && (Number(p.sign) === -1 ? 'short' : 'long') === o.side ? Math.round(Math.abs(Number(p.size)) * 10 ** o.sizeDec) : 0;
    const moved = Math.min(o.ask ?? Infinity, Math.max(0, o.kind === 'open' ? here - o.base : o.base - here));
    const whole = o.ask != null && traded >= o.ask;
    // counted from when the venue said yes; without its answer, from past the call's own timeout
    const quiet = Date.now() - (o.sent ? Number(o.sentAt || o.at) : o.at + 60_000);
    const over = whole || (traded >= moved && (age >= config.LIGHTER_ORDER_EXPIRY_MS || ((o.sent || traded > 0) && quiet >= config.LIGHTER_ORDER_SETTLE_MS)));
    if (!over && !late) continue;
    st.perpOrder = null;
    if (over) bookOrder(coin, st, o, traded, price);
    else {
      // its trades never showed up: what the position and the cash did instead
      const guess = priceFromAccount(o, moved, acc, p);
      console.log(`  [${coin.symbol}] order ${o.kind} ${o.side}: no trades to read after ${Math.round(age / 60000)} min, booked from the account (${moved} @ ${guess})`);
      bookOrder(coin, st, o, guess > 0 ? moved : 0, guess);
    }
    checkpoint();
    return true;
  }
  if (tries > 1) console.log(`  [${coin.symbol}] order ${o.kind} ${o.side}: not settled yet, nothing else moves until it is`);
  return false;
}

/**
 * The price an order must have had for the account to be where it is: an opening from the average
 * entry, a close from the cash it left, never better than the mark it was sent at (a deposit landed
 * meanwhile is not a gain).
 */
function priceFromAccount(o, moved, acc, p) {
  if (!(moved > 0)) return 0;
  const units = moved / 10 ** o.sizeDec;
  if (o.kind === 'open') {
    const px = (Number(p.avg_entry_price) * (o.base + moved) - Number(o.avgEntry || 0) * o.base) / moved;
    return px > 0 ? px : Number(p.avg_entry_price);
  }
  const dir = o.side === 'short' ? -1 : 1;
  const got = isolatedCash(acc) - Number(o.cash || 0) - o.margin * moved / o.base;
  const atMark = dir * (Number(o.mark || o.avgEntry) - o.avgEntry) * units;
  return Math.max(1e-12, o.avgEntry + dir * Math.min(got, atMark) / units);
}

/** one settled order into the books: everything it changes, in the caller's one checkpoint */
function bookOrder(coin, st, o, filled, price) {
  if (!Array.isArray(st.perpTranches)) st.perpTranches = [];
  const units = filled / 10 ** o.sizeDec;
  if (o.kind === 'open') {
    if (filled <= 0) {
      console.log(`  [${coin.symbol}] perp open NON riempito (IOC senza controparte: book vuoto o mercato chiuso?): collaterale intatto, riprovo al tick dopo`);
      return;
    }
    const { merged } = addTranche(st.perpTranches, { base: filled, entryMark: price, collateralUsd: units * price / o.leverage, sizeDec: o.sizeDec, ts: o.at, leverage: o.leverage }, o.minBaseUnits);
    const topup = st.perpOpen;
    st.perpOpen = true; st.perpCarry = false;
    st.perpFilling = Number(o.split || 0) > 0 || (o.ask != null && filled < o.ask * 0.99);
    st.perpOpenSplit = Math.max(0, Number(o.split || 0) - 1);
    st.perpTrancheAt = Date.now();
    console.log(`  [${coin.symbol}] perp ${topup ? 'topup' : 'open'}: notional $${(units * price).toFixed(2)} ${o.side} ${o.leverage}x (fill ${filled}/${o.ask ?? '?'} @ ${price})${merged ? ' — scheggia fusa nella tranche precedente' : ''}`);
    return;
  }
  const out = filled > 0 ? closeProceeds({ filled, base: o.base, price, avgEntry: o.avgEntry, margin: o.margin, side: o.side, sizeDec: o.sizeDec }) : null;
  if (o.kind === 'tp') {
    if (!out) { console.log(`  [${coin.symbol}] TAKE-PROFIT: nessun fill (book vuoto o mercato chiuso?), riprovo al tick dopo`); return; }
    st.perpTranches = removeClosedBase(o.ready, filled).concat(o.keep);
    st.perpOpen = st.perpTranches.length > 0; st.perpTpSplit = Math.max(0, Number(st.perpTpSplit || 0) - 1);
    st.perpTpDeep = o.count && o.count < o.of ? o.count * 2 : 0; // what the book took, and a little more next time
    st.perpRealizedUsd = Number(st.perpRealizedUsd || 0) + out.profit;
    st.perpCapitalUsd = Number(st.perpCapitalUsd || 0) + out.capital;
    console.log(`  [${coin.symbol}] TAKE-PROFIT (+${o.tpPct}%): chiusa base ${filled}/${o.ask} @ ${price}, fuori dal motore $${out.capital.toFixed(2)} di capitale + $${out.profit.toFixed(2)} di guadagno`);
    return;
  }
  if (o.kind === 'retire') {
    if (out) { st.perpTranches = []; st.perpOpen = filled < o.base; st.perpTpSplit = 0; }
    console.log(`  [${coin.symbol}] retired: ${out ? `closed ${o.label} ${filled}/${o.base} @ ${price}, result $${out.pnl.toFixed(2)}` : `closing ${o.label} did not fill, trying again`}`);
    return;
  }
  // a managed coin's switch: the capital stays for the new engine, a net gain is banked
  const sw = st.perpSwitch || (st.perpSwitch = { from: st.perpEngine, to: { market: coin.market, side: coin.side }, since: o.at });
  if (!out) {
    sayOnce(coin, sw, `closing ${o.label} did not fill (empty book or market closed), trying again every tick`);
    noteSmall(coin, st, sw, o);
    return;
  }
  sw.split = Math.max(0, Number(sw.split || 0) - 1);
  const left = o.base - filled;
  if (o.own) {
    if (st.perpTranches.length) {
      sw.pnl = Number(sw.pnl || 0) + out.pnl;
      st.perpTranches = reconcileTranches(reconcileTranches(st.perpTranches, o.base, price, o.sizeDec).tranches, left, price, o.sizeDec).tranches;
    }
    st.perpOpen = left > 0;
  }
  console.log(`  [${coin.symbol}] switch: closed ${o.label} ${filled}/${o.base} @ ${price}, result so far $${Number(sw.pnl || 0).toFixed(2)}`);
  if (left === 0) bankSwitch(coin, st);
}

/** the same trouble every tick is one line, not one line every tick */
function sayOnce(coin, sw, msg) {
  if (sw.said === msg) return;
  sw.said = msg; console.log(`  [${coin.symbol}] switch: ${msg}`);
}

/** a leftover below the venue's minimum, refused or not filled three times, is left alone */
function noteSmall(coin, st, sw, { marketIndex, base, minAsk, label, size }) {
  if (base >= minAsk) return;
  sw.small = { ...(sw.small || {}), [marketIndex]: Number((sw.small || {})[marketIndex] || 0) + 1 };
  if (sw.small[marketIndex] < 3) return;
  if (!st.perpDust) st.perpDust = {};
  st.perpDust[marketIndex] = size;
  sayOnce(coin, sw, `${label} leftover of ${base} units is below the venue's minimum, left alone`);
}

/** what left the engine and is still in the Lighter account: gains (less funding owed) and capital */
const outOfEngine = (st) => Math.max(0, Number(st.perpRealizedUsd || 0) + Number(st.perpCapitalUsd || 0));

/**
 * The next withdrawal: all that left the engine, never more than the cash there is. Closing some
 * tranches of a netted position pays at its average entry, so the cash can come later than the
 * book says; what is not there yet waits. `profit` is the part the protocol's share is taken on.
 */
function withdrawalOf(st, cash) {
  const total = outOfEngine(st);
  const amount = Math.min(total, Math.max(0, cash));
  if (!(amount > 0)) return { amount: 0, profit: 0 };
  return { amount, profit: Math.min(total, Math.max(0, Number(st.perpRealizedUsd || 0))) * (amount / total) };
}

/**
 * Sends what left the engine home. On disk before it is sent, with the cash it is sent from: it is
 * believed only when that cash is gone (settleWithdrawal), and nothing else moves until then.
 * Returns true when one may have left: the tick ends there. A refusal (below the venue's minimum) is
 * tried again later, and holds nothing else.
 */
async function withdrawProceeds({ coin, st, checkpoint, accountIndex, apiPrivKey, apiKeyIndex, sim, tag, floor = config.PERP_WITHDRAW_FLOOR_USD }) {
  if (outOfEngine(st) < floor || Date.now() < Number(st.perpWithdrawRetryAt || 0)) return false;
  const now = await lighter.account(accountIndex);
  const cash = isolatedCash(now);
  const { amount: exact, profit: exactProfit } = withdrawalOf(st, Math.min(cash, Number(now.available_balance ?? cash)) - Number(st.perpDoubtUsd || 0));
  const amount = Math.floor(exact * 1e6) / 1e6; // USDC's own decimals, never rounded over the balance
  const profit = Math.min(amount, exactProfit);
  if (amount < floor) return false; // the cash is not all there yet
  if (sim) {
    console.log(`  [${coin.symbol}] ${tag}preleverei $${amount.toFixed(2)} da Lighter → sub-wallet ($${profit.toFixed(2)} di guadagno)`);
    return false;
  }
  // the block before the intent: an arrival seen before it would be nobody's
  if (!st.perpWithdrawBlock) { st.perpWithdrawBlock = await provider.getBlockNumber(); st.perpWithdrawScanBlock = st.perpWithdrawBlock - 1; }
  const was = { realized: Number(st.perpRealizedUsd || 0), capital: Number(st.perpCapitalUsd || 0) };
  // the gain goes for its part, the capital for the rest; funding owed (a negative gain) has
  // already been taken off the total
  st.perpRealizedUsd = was.realized < 0 ? 0 : was.realized - profit;
  st.perpCapitalUsd = Math.max(0, was.capital + Math.min(0, was.realized) - (amount - profit));
  if (st.perpCapitalUsd < 1e-6) st.perpCapitalUsd = 0;
  if (Math.abs(st.perpRealizedUsd) < 1e-6) st.perpRealizedUsd = 0;
  st.perpWithdrawIntentUsd = amount; st.perpWithdrawIntentProfitUsd = profit;
  st.perpWithdrawCashUsd = cash; st.perpWithdrawAt = Date.now(); st.perpWithdrawWas = was; st.perpWithdrawSent = false; st.perpWithdrawTx = null;
  checkpoint();
  try {
    const sent = await lighter.withdraw({ accountIndex, amount, apiPrivKey, apiKeyIndex });
    st.perpWithdrawSent = true; st.perpWithdrawTx = (sent && sent.txHash) || null; checkpoint();
    console.log(`  [${coin.symbol}] withdraw: $${amount.toFixed(2)} da Lighter → sub-wallet, di cui $${profit.toFixed(2)} di guadagno`);
  } catch (e) {
    if (e && e.definitive) {
      // es. importo sotto il minimo di Lighter: non e' partito nulla
      undoWithdrawal(st); st.perpWithdrawRetryAt = Date.now() + (e.retry && !e.limited ? 60_000 : 30 * 60 * 1000); checkpoint();
      console.log(`  [${coin.symbol}] withdraw rifiutato da Lighter ($${amount.toFixed(2)}): riaccreditato, si ritenta piu' avanti (${e.message.slice(0, 80)})`);
      return false;
    } else {
      st.perpWithdrawTx = e.txHash || null; checkpoint();
      console.log(`  [${coin.symbol}] withdraw di $${amount.toFixed(2)} con esito ignoto (${e.message.slice(0, 80)}): lo dira' ${e.txHash ? 'la sua transazione' : 'il saldo'}`);
    }
  }
  return true;
}

function clearIntent(st) {
  st.perpWithdrawIntentUsd = 0; st.perpWithdrawIntentProfitUsd = 0;
  st.perpWithdrawCashUsd = null; st.perpWithdrawWas = null; st.perpWithdrawSent = false; st.perpWithdrawTx = null; st.perpWithdrawUnread = 0;
}
function undoWithdrawal(st) {
  st.perpRealizedUsd = st.perpWithdrawWas.realized; st.perpCapitalUsd = st.perpWithdrawWas.capital;
  clearIntent(st);
  // an old window left open would take somebody's later transfer for this withdrawal
  if (!(Number(st.perpWithdrawPendingUsd) > 0)) { st.perpWithdrawBlock = null; st.perpWithdrawScanBlock = null; }
}
function intentToPending(st) {
  st.perpWithdrawPendingUsd = Number(st.perpWithdrawPendingUsd || 0) + Number(st.perpWithdrawIntentUsd);
  st.perpWithdrawPendingProfitUsd = Number(st.perpWithdrawPendingProfitUsd || 0) + Number(st.perpWithdrawIntentProfitUsd || 0);
  clearIntent(st);
}

/** did the withdrawal in flight leave? Its cash says so; false while it does not say yet */
async function settleWithdrawal({ coin, st, checkpoint, accountIndex }) {
  const amount = Number(st.perpWithdrawIntentUsd || 0);
  if (!(amount > 0) || st.perpWithdrawCashUsd == null) return true;
  const cash = isolatedCash(await lighter.account(accountIndex));
  const age = Date.now() - Number(st.perpWithdrawAt || 0);
  if (cash <= Number(st.perpWithdrawCashUsd) - amount / 2) {
    intentToPending(st); checkpoint();
    console.log(`  [${coin.symbol}] withdraw: $${amount.toFixed(2)} in arrivo`);
    return true;
  }
  const undo = (why) => {
    undoWithdrawal(st);
    st.perpWithdrawRetryAt = Date.now() + 30 * 60 * 1000; // whatever failed it is not asked again at once
    checkpoint();
    console.log(`  [${coin.symbol}] withdraw di $${amount.toFixed(2)} ${why}: riaccreditato`);
    return true;
  };
  // its own transaction knows, when there is one; nothing that is not executed by its expiry will be
  if (st.perpWithdrawTx) {
    let t;
    try { t = await lighter.tx(st.perpWithdrawTx, accountIndex); }
    catch {
      // Not being able to ask is not an answer: nothing else of this token moves until there is one.
      // After hours of it the token is given back to its work, with that money kept out of it.
      if (!st.perpWithdrawUnread) { st.perpWithdrawUnread = Date.now(); checkpoint(); }
      if (Date.now() - st.perpWithdrawUnread < config.TX_UNREAD_MS) return false;
      st.perpDoubtUsd = Number(st.perpDoubtUsd || 0) + amount;
      intentToPending(st); checkpoint();
      console.log(`  [${coin.symbol}] withdraw di $${amount.toFixed(2)}: la sua transazione non si legge da ore, trattato come inviato e tenuto fuori dal motore`);
      return true;
    }
    st.perpWithdrawUnread = 0;
    if (t && t.status === 0) return undo('fallito');
    if (t && t.status >= 2) {
      intentToPending(st); checkpoint();
      console.log(`  [${coin.symbol}] withdraw: $${amount.toFixed(2)} eseguito, in arrivo`);
      return true;
    }
    if (age < config.LIGHTER_ORDER_EXPIRY_MS) return false;
    return undo('mai eseguito');
  }
  if (age < config.LIGHTER_ORDER_EXPIRY_MS) return false;
  // No transaction to ask about (killed between signing and knowing): the cash says it, with the
  // one deposit that may have landed meanwhile. Taken back only when the venue never said yes and
  // the cash is, to the cent, what it would be without it; otherwise it may have left: it is
  // treated as sent, and credited only if it really arrives.
  const moved = cash - Number(st.perpWithdrawCashUsd), landed = Number(st.perpDepositUsd || 0);
  const untouched = Math.abs(moved) <= 0.01 || (landed > 0 && Math.abs(moved - landed) <= 0.01);
  if (st.perpWithdrawSent || !untouched) {
    intentToPending(st); checkpoint();
    console.log(`  [${coin.symbol}] withdraw di $${amount.toFixed(2)} non verificabile: trattato come inviato`);
    return true;
  }
  return undo('mai eseguito');
}

/**
 * Whether the fees waiting may leave for Lighter now. The first position waits a little after the
 * launch, an open one takes a tranche per interval, a closed one reopens at once; and never while
 * the deposit before is still on its way, or the next would be left over for an interval.
 */
function depositDue({ coin, st, usd, now = Date.now() }) {
  if (usd < (st.perpOpen ? config.TOPUP_STEP_USD : config.OPEN_GATE_USD)) return false;
  if (Number(st.perpWithdrawIntentUsd || 0) > 0) return false; // its cash is being watched
  if (st.perpOpen) return now - Math.max(Number(st.perpTrancheAt || 0), Number(st.perpDepositAt || 0)) >= config.TRANCHE_INTERVAL_MS;
  if (!(Number(st.perpDepositedUsd) > 0)) {
    const born = Date.parse(coin.createdAt);
    if (Number.isFinite(born) && now - born < config.FIRST_OPEN_DELAY_MS) return false;
  }
  const inFlight = Number(st.perpDepositAt || 0) > Number(st.perpTrancheAt || 0) && now - Number(st.perpDepositAt) < 10 * 60 * 1000;
  return !inFlight;
}

/** an opening filled in part a moment ago: the rest of it may go in without waiting */
const filling = (st, now = Date.now()) => st.perpFilling === true && now - Number(st.perpTrancheAt || 0) < 10 * 60 * 1000;

/** the least free collateral worth an order: a tranche's, unless it is finishing one or carrying on after a switch */
function minDeploy(st) {
  if (filling(st) || st.perpCarry) return config.MIN_DEPLOY_USD;
  const step = st.perpOpen ? config.TOPUP_STEP_USD : config.OPEN_GATE_USD;
  return Math.max(config.MIN_DEPLOY_USD, step * config.COLLATERAL_HEADROOM * 0.9);
}

/** an arrival from the bridge: the protocol's share of its gain, everything else buys back */
function splitArrival(creditRaw, pendingUsd, pendingProfitUsd) {
  const ppm = pendingUsd > 0 ? Math.round(Math.max(0, Math.min(1, pendingProfitUsd / pendingUsd)) * 1e6) : 0;
  const toTreasury = creditRaw.mul(ppm).div(1e6).mul(config.TP_MASTER_SHARE_BPS).div(10000);
  return { toTreasury, toBuyback: creditRaw.sub(toTreasury) };
}

/** funding since the last read, for the record (see step 5b) */
function applyFunding(coin, st, positions, { sim, tag, checkpoint }) {
  const f = fundingDelta(st.perpFundingSeen, positions);
  st.perpFundingSeen = f.seen;
  if (Math.abs(f.delta) < 0.000001) return;
  st.perpFundingUsd = Number(st.perpFundingUsd || 0) + f.delta;
  if (!sim) checkpoint();
  console.log(`  [${coin.symbol}] ${tag}funding ${f.delta >= 0 ? '+' : ''}$${f.delta.toFixed(6)} (cumulato $${Number(st.perpFundingUsd).toFixed(6)})`);
}

/** the net result of a switch, once: a profit is realized, a loss has already left the collateral */
function bankSwitch(coin, st) {
  const pnl = Number((st.perpSwitch || {}).pnl || 0);
  if (st.perpSwitch) st.perpSwitch.pnl = 0;
  if (!(pnl > 0)) return;
  st.perpRealizedUsd = Number(st.perpRealizedUsd || 0) + pnl;
  console.log(`  [${coin.symbol}] switch: banked $${pnl.toFixed(2)}`);
}

/**
 * A managed coin's creator moved the engine to another market or side: close everything the new
 * engine does not own, whole and reduce-only, before anything is opened. Returns true when this
 * tick must stop here (something is still open, or was just closed and the account must be read
 * again), false when the account holds only what the engine owns.
 *
 * The venue's positions are the truth, not our state: a position left by a crash, or found after
 * the registry was rebuilt, is closed the same way. A closed market or an empty book is not an
 * error: nothing opens until the close fills, and every tick tries again.
 */
async function settleEngineSwitch({ coin, st, checkpoint, accountIndex, marketIndex, apiPrivKey, apiKeyIndex, sim, tag }) {
  const now = { market: coin.market, side: coin.side };
  const same = (e) => e && e.market === now.market && e.side === now.side;
  if (!await settleOrder({ coin, st, checkpoint, accountIndex })) return true;
  if (same(st.perpEngine) && !st.perpSwitch) return false;

  const acc = await lighter.account(accountIndex);
  if (!Array.isArray(st.perpTranches)) st.perpTranches = [];
  if (!st.perpDust) st.perpDust = {};
  const strays = strayPositions(acc.positions, marketIndex, coin.side).filter((p) => !isDust(st, p));
  const from = st.perpEngine || now;

  if (!strays.length) {
    // nothing left of the old engine. Its tranches, if any, went with a position that closed
    // without us seeing the fill (liquidated, or the read after the order failed): no credit,
    // what it made stays in the account as collateral.
    if (!same(st.perpEngine) && st.perpEngine && st.perpTranches.length) {
      console.log(`  [${coin.symbol}] ${tag}switch: the ${from.market} ${from.side} position is gone, its tranches are dropped`);
      st.perpTranches = []; st.perpOpen = false;
    }
    if (st.perpSwitch) {
      console.log(`  [${coin.symbol}] ${tag}switch done: now ${now.market} ${now.side}`);
      st.perpCarry = !st.perpOpen; // the old engine's capital opens the new one, whatever is left of it
    }
    bankSwitch(coin, st); // a change taken back half way: what was already closed
    st.perpEngine = now; st.perpSwitch = null; st.perpTpDeep = 0; st.perpTpSplit = 0;
    if (!sim) checkpoint();
    return false;
  }

  if (!st.perpSwitch || st.perpSwitch.to.market !== now.market || st.perpSwitch.to.side !== now.side) {
    st.perpSwitch = { ...(st.perpSwitch || {}), from, to: now, since: st.perpSwitch ? st.perpSwitch.since : Date.now() };
    if (!sim) checkpoint();
    console.log(`  [${coin.symbol}] ${tag}switch ${from.market} ${from.side} → ${now.market} ${now.side}: closing ${strays.length} position(s) first`);
  }
  applyFunding(coin, st, acc.positions, { sim, tag, checkpoint });

  const sw = st.perpSwitch;
  const say = (msg) => sayOnce(coin, sw, msg);
  for (const p of strays) {
    const m = await lighter.marketById(p.market_id);
    if (!m) { say(`market ${p.market_id} is not on the venue's list, waiting`); continue; }
    const side = Number(p.sign) === -1 ? 'short' : 'long';
    const label = `${m.symbol} ${side}`;
    if (sim) { console.log(`  [${coin.symbol}] ${tag}switch: would close ${label} (${p.size})`); continue; }
    const before = await lighter.account(accountIndex);
    const live = strayPositions((before.positions || []).filter((x) => Number(x.market_id) === Number(p.market_id) && Number(x.sign) === Number(p.sign)), null, side)[0];
    if (!live) continue; // closed since the first read: the next tick settles the books
    const base = Math.round(Math.abs(Number(live.size)) * 10 ** m.sizeDec);
    const mark = markFromPosition(live, side);
    // the smallest order the venue takes, by size and by value
    const minAsk = Math.max(m.minBaseUnits || 1, mark > 0 ? Math.ceil((m.minQuoteUsd || 0) / mark * 10 ** m.sizeDec) : 1);
    // A book too thin for the whole size within the slippage limit refuses the order outright:
    // each refusal halves the next attempt, and after the smallest it starts over from the whole.
    const split = Number(sw.split || 0);
    let ask = split > 0 ? Math.min(base, Math.max(minAsk, Math.floor(base / 2 ** split))) : base;
    if (base - ask < minAsk) ask = base; // never leave behind what could not be closed on its own
    const own = m.symbol === from.market && side === from.side;
    const note = { marketIndex: Number(p.market_id), base, minAsk, label, size: Math.abs(Number(live.size)) };
    const margin = Number(live.allocated_margin) > 0 ? Number(live.allocated_margin) : 0;
    const o = recordOrder(st, checkpoint, { kind: 'switch', side, sizeDec: m.sizeDec, ask, own, margin, mark, cash: isolatedCash(before), avgEntry: Number(live.avg_entry_price), ...note });
    try {
      await lighter.close({ accountIndex, marketIndex: p.market_id, baseAmount: ask, isAsk: side === 'long', maxSlippage: config.LIGHTER_MAX_SLIPPAGE, clientOrderIndex: o.id, apiPrivKey, apiKeyIndex });
    } catch (e) {
      if (!(e && e.definitive)) throw e; // unknown: the order stays on record and is settled on its trades
      st.perpOrder = null;
      if (e.retry) { checkpoint(); say(`closing ${label}: ${e.message.slice(0, 100)}, again next tick`); continue; }
      sw.split = split >= 5 ? 0 : split + 1;
      say(`closing ${label} refused (${e.message.slice(0, 100)}), trying again with other sizes`);
      noteSmall(coin, st, sw, note); checkpoint();
      continue;
    }
    o.sent = true; o.sentAt = Date.now(); checkpoint();
    if (!await settleOrder({ coin, st, checkpoint, accountIndex, tries: config.LIGHTER_FILL_TRIES })) return true;
    if (!st.perpSwitch) return true;
  }
  return true;
}

/**
 * A token taken out of service (PERPSPAD_RETIRED): its positions are closed, everything its account
 * and its wallet hold goes to the treasury, and nothing is ever opened, bought back or deposited
 * again. Fees that still reach it follow the same way.
 */
async function retireTick(keeper, coin, st, checkpoint, sub, unitUsd, quote) {
  // what was already leaving is settled first: the sweep takes all that is left
  const known = await settleTxOut({ coin, st, checkpoint, wallet: sub, keeper });
  if (coin.venue === 'v4') {
    try { await claimV4(keeper, coin, st, checkpoint, sub, unitUsd); }
    catch (e) { console.log(`  [${coin.symbol}] retired: fees not collected now (${e.message.slice(0, 80)})`); }
  }
  const held = await quote.balanceOf(sub.address);
  if (known && usdOf(held, coin.pairDecimals, unitUsd) >= config.CLAIM_MIN_USD && config.TREASURY) {
    await ensureGas(keeper, sub.address);
    await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('transfer', [config.TREASURY, held]), gasLimit: 100000 }, 'retired sweep');
    for (const b of ['perpReserveRaw', 'buybackReserveRaw', 'treasuryOwedRaw', 'creatorOwedRaw']) st[b] = '0';
    st.perpWithdrawPendingUsd = 0; st.perpWithdrawPendingProfitUsd = 0; st.perpWithdrawBlock = null; st.perpWithdrawScanBlock = null;
    checkpoint();
    console.log(`  [${coin.symbol}] retired: ${ethers.utils.formatUnits(held, coin.pairDecimals)} ${coin.pairSymbol} → ${config.TREASURY}`);
  }
  if (!lighter.enabled || lighter.simulate) return;
  let accountIndex = st.lighterAccountIndex;
  if (accountIndex == null) {
    accountIndex = (await lighter.resolveAccount(sub.address)).accountIndex;
    if (accountIndex == null) return;
    st.lighterAccountIndex = accountIndex; checkpoint();
  }
  if (!st.lighterApiPrivKey) {
    const r = await lighter.registerKey({ accountIndex, apiKeyIndex: config.LIGHTER_API_KEY_INDEX, ethPrivKey: sub.privateKey });
    st.lighterApiPrivKey = encryptSecret(r.apiPrivKey); st.lighterApiKeyIndex = r.apiKeyIndex; checkpoint();
  }
  const apiPrivKey = decryptSecret(st.lighterApiPrivKey), apiKeyIndex = st.lighterApiKeyIndex;
  const ctx = { coin, st, checkpoint, accountIndex, apiPrivKey, apiKeyIndex, sim: false, tag: '' };
  if (!(await settleOrder(ctx) && await settleWithdrawal(ctx))) return;

  const acc = await lighter.account(accountIndex);
  const pos = (acc.positions || []).find((p) => Math.abs(Number(p.size)) > 0);
  if (pos) {
    const m = await lighter.marketById(pos.market_id);
    if (!m) return;
    const side = Number(pos.sign) === -1 ? 'short' : 'long';
    const base = Math.round(Math.abs(Number(pos.size)) * 10 ** m.sizeDec);
    const split = Number(st.perpTpSplit || 0);
    const ask = split > 0 ? Math.max(Math.min(base, m.minBaseUnits || 1), Math.floor(base / 2 ** split)) : base;
    const o = recordOrder(st, checkpoint, { kind: 'retire', marketIndex: Number(pos.market_id), label: `${m.symbol} ${side}`, side, sizeDec: m.sizeDec, base, ask, avgEntry: Number(pos.avg_entry_price), margin: Number(pos.allocated_margin) || 0, mark: markFromPosition(pos, side), cash: isolatedCash(acc) });
    try {
      await lighter.close({ accountIndex, marketIndex: o.marketIndex, baseAmount: ask, isAsk: side === 'long', maxSlippage: config.LIGHTER_MAX_SLIPPAGE, clientOrderIndex: o.id, apiPrivKey, apiKeyIndex });
    } catch (e) {
      if (!(e && e.definitive)) throw e;
      st.perpOrder = null; if (!e.retry) st.perpTpSplit = split >= 5 ? 0 : split + 1; checkpoint();
      if (split === 0) console.log(`  [${coin.symbol}] retired: closing ${o.label} refused (${e.message.slice(0, 100)})`);
      return;
    }
    o.sent = true; o.sentAt = Date.now(); checkpoint();
    await settleOrder({ ...ctx, tries: config.LIGHTER_FILL_TRIES });
    return;
  }
  // all the cash is out of the engine, and none of it is a gain anybody has a share of
  st.perpRealizedUsd = 0; st.perpCapitalUsd = Math.min(isolatedCash(acc), Number(acc.available_balance ?? Infinity));
  st.perpTranches = []; st.perpOpen = false;
  await withdrawProceeds({ ...ctx, floor: 0.01 });
}

async function perpTick(keeper, coin, st, checkpoint, sub, unitUsd, quote, { urgent = false } = {}) {
  if (coin.pair.toLowerCase() !== config.USDG.toLowerCase()) {
    if (!st.perpGateLogged) { console.log(`  [${coin.symbol}] perp saltato: quote non USDG (il collaterale Lighter e' USDG)`); st.perpGateLogged = true; checkpoint(); }
    return;
  }
  if (coin.venue === 'v4' && coin.managed && coin.engineRead === false) {
    // the launch event is not the engine it runs now: wait for one good read of the router
    console.log(`  [${coin.symbol}] engine not read from the router yet: no perp this tick`);
    return;
  }
  const sim = lighter.simulate; // dry-run: letture ok, nessuna tx/ordine
  const shortBefore = st.perpShortSeen === true;
  st.perpShortSeen = false; // two reads in a row means two ticks in a row (step 7)
  const tag = sim ? 'SIMULATE ' : '';
  // mercato Lighter della coin (BTC, NVDA, NVDA/USDG, …)
  // A managed coin can be pointed at a symbol the venue does not list (the router only checks its
  // shape): that engine takes no exposure, but what the previous one left open must still close.
  let mkt = null;
  try { mkt = await lighter.market(coin.market); }
  catch (e) { if (!coin.managed || !(e && e.unknownMarket)) throw e; }
  const marketIndex = mkt ? mkt.index : null;
  const isAsk = coin.side === 'short'; // long = buy (is_ask false)

  // The router checks leverage against its own list, not against the venue: a coin can ask for
  // more than Lighter allows on its market (at launch, or after an engine change). Such an
  // engine takes no new exposure: no leverage update, no open or top-up. Deposits, take-profit,
  // reconciliation and withdraw keep running, so the tranches already open are still managed.
  {
    const blocked = !mkt ? `${coin.market} is not listed on Lighter`
      : mkt.maxLeverage != null && coin.leverage > mkt.maxLeverage
      ? `${coin.leverage}x is above ${coin.market}'s ${mkt.maxLeverage}x cap on Lighter` : null;
    if (blocked !== (st.engineBlocked ?? null)) {
      st.engineBlocked = blocked;
      if (!sim) checkpoint();
      console.log(blocked
        ? `  [${coin.symbol}] ${tag}engine blocked: ${blocked}. No new positions until the engine fits the venue`
        : `  [${coin.symbol}] ${tag}engine unblocked: ${coin.leverage}x fits ${coin.market} on Lighter`);
    }
  }

  // 1) DEPOSITO: manda la riserva accumulata all'intent-address (tx reale su 4663)
  const perpUsd = usdOf(BN(st.perpReserveRaw), coin.pairDecimals, unitUsd);
  // (a take-profit called by a live mark does not stop for it: the round will)
  if (!urgent && !st.txOut && depositDue({ coin, st, usd: perpUsd })) try { // a deposit that fails holds nothing else
    const depositBefore = Number(st.perpDepositAt || 0);
    const depositRaw = BN(st.perpReserveRaw);
    const { intentAddress } = await lighter.intentAddress({ chainId: '4663', fromAddr: sub.address, amount: depositRaw.toString() });
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}perp deposit: depositerei $${perpUsd.toFixed(2)} USDG → Lighter (intent ${intentAddress})`);
    } else {
      await ensureGas(keeper, sub.address);
      st.perpDepositAt = Date.now(); st.perpDepositUsd = perpUsd;
      try {
        await moving({
          st, checkpoint, wallet: sub, bucket: 'perpReserveRaw', raw: depositRaw, label: 'perp deposit',
          tx: { to: coin.pair, data: quote.interface.encodeFunctionData('transfer', [intentAddress, depositRaw]), gasLimit: 100000 },
          extra: { depositedUsd: perpUsd, perpDepositAt: depositBefore }, onDone: () => { st.perpDepositedUsd = Number(st.perpDepositedUsd || 0) + perpUsd; },
        });
        console.log(`  [${coin.symbol}] perp deposit: $${perpUsd.toFixed(2)} USDG → Lighter (intent ${intentAddress})`);
      } catch (e) {
        if (isStuck(e)) console.log(`  [${coin.symbol}] perp deposit in viaggio (${e.hash}): l'esito al prossimo giro`);
        throw e;
      }
    }
  } catch (e) { console.log(`  [${coin.symbol}] perp deposit: ${e.message.slice(0, 140)}`); }

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

  // 3a) what was in flight comes first: an order or a withdrawal whose end is not known stops the
  //     tick here. Then the withdrawal of what left the engine, before anything that may not let
  //     the tick reach it (a closed market, a refused order, a market that is not listed).
  const ctx = { coin, st, checkpoint, accountIndex, apiPrivKey, apiKeyIndex, sim, tag };
  if (!sim && !(await settleOrder(ctx) && await settleWithdrawal(ctx))) return;
  if (await withdrawProceeds(ctx)) return;

  // 3b) ENGINE SWITCH: nothing below runs while a position of the previous engine is open
  if (coin.managed && await settleEngineSwitch({ coin, st, checkpoint, accountIndex, marketIndex, apiPrivKey, apiKeyIndex, sim, tag })) return;
  if (!mkt) return;

  // 4) LEVERAGE on the venue: set at launch, and again whenever the engine changes.
  //    `lighterLeverage` is what Lighter actually has; everything sized below uses it, not the
  //    desired value, so a change the venue refuses never produces a position sized for a
  //    leverage it does not have.
  if (st.lighterLeverage == null && st.lighterLeverageSet === true) {
    // state from before leverage could change: the flag meant "set to the launch leverage"
    st.lighterLeverage = coin.leverage;
    if (!sim) checkpoint();
  }
  const marginMode = config.LIGHTER_ISOLATED ? 'isolated' : 'cross';
  if (!st.engineBlocked && st.lighterLeverage !== coin.leverage) {
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}would set leverage ${coin.leverage}x ${marginMode}${st.lighterLeverage != null ? ` (venue has ${st.lighterLeverage}x)` : ''}`);
    } else {
      try {
        await lighter.setLeverage({ accountIndex, marketIndex, leverage: coin.leverage, isolated: config.LIGHTER_ISOLATED, apiPrivKey, apiKeyIndex });
        const prev = st.lighterLeverage;
        st.lighterLeverage = coin.leverage; st.lighterLeverageRejected = null; checkpoint();
        console.log(`  [${coin.symbol}] leverage ${prev != null ? `${prev}x → ` : ''}${coin.leverage}x ${marginMode} set on ${coin.market}`);
      } catch (e) {
        // ambiguous (timeout, crash), or a venue too busy to judge it: the tick stops here and the
        // next one retries. Nothing is opened at a leverage that may not be the one asked for.
        if (!(e && e.definitive) || e.retry) throw e;
        // refused by Lighter: nothing changed on the venue. Keep trading at the leverage it
        // has (if any); the refusal is logged once per target, not every tick.
        if (st.lighterLeverageRejected !== coin.leverage) {
          st.lighterLeverageRejected = coin.leverage; checkpoint();
          console.log(`  [${coin.symbol}] leverage ${coin.leverage}x refused by Lighter (${e.message.slice(0, 100)}): ${st.lighterLeverage != null ? `staying at ${st.lighterLeverage}x` : 'no position is opened until it is accepted'}`);
        }
      }
    }
  }
  // the leverage new exposure is sized at: the venue's. In simulate nothing is ever set, so
  // the dry run sizes at the desired one, as it always has.
  const venueLeverage = st.lighterLeverage ?? (sim ? coin.leverage : null);

  // 5) stato conto/posizione. Il saldo LIBERO e' available_balance: `collateral`
  //    in modalita' cross INCLUDE il margine delle posizioni (verificato su API) e
  //    usarlo come deployable causerebbe topup compounding fino alla liquidazione.
  const acc = await lighter.account(accountIndex);
  let pos = (acc.positions || []).find((p) => Number(p.market_id) === Number(marketIndex));
  const stray = coin.managed ? strayPositions(acc.positions, marketIndex, coin.side).find((p) => !isDust(st, p)) : null;
  if (stray) {
    // a position the engine does not own, found outside a switch: close it first, trade after
    const sm = await lighter.marketById(stray.market_id);
    st.perpSwitch = { from: { market: sm ? sm.symbol : `market ${stray.market_id}`, side: Number(stray.sign) === -1 ? 'short' : 'long' }, to: { market: coin.market, side: coin.side }, since: Date.now() };
    if (!sim) checkpoint();
    return;
  }
  // dust on the other side of this market is not the engine's position
  if (coin.managed && pos && strayPositions([pos], marketIndex, coin.side).length) pos = undefined;
  //    And in isolated mode `available_balance` counts the open profit as free (seen live: a top-up
  //    bought with it seconds before the take-profit), while `collateral` is the cash alone. The
  //    lower of the two is what is there in either mode.
  const freeCollateralUsd = Math.min(Number(acc.available_balance ?? acc.collateral ?? 0), Number(acc.collateral ?? Infinity));

  // 5b) FUNDING. Lighter settles it in the position's margin (read live: the margin moves with the
  //     counter, the cash does not), so it comes out with the margin when a tranche closes. Here it
  //     is only kept for the site: booked as a gain too, it would be counted twice.
  applyFunding(coin, st, acc.positions, { sim, tag, checkpoint });

  // 6) TAKE-PROFIT per tranche: riconcilia la contabilita' con la size on-chain,
  //    poi chiude (reduce-only) le tranche il cui target e' stato raggiunto.
  //    Ogni tranche corre verso il SUO entry × (1 ± trigger/leva): i topup non
  //    diluiscono il progresso delle tranche vecchie.
  //    The trigger decays with each tranche's age (effectiveTrigger); tranches without their own
  //    leverage were opened at the one the venue had, the best fallback there is.
  const triggerFrac = coinTrigger(coin);
  const tpLabel = `+${Math.round(triggerFrac * 100)}%`;
  if (!Array.isArray(st.perpTranches)) st.perpTranches = [];
  {
    // pos assente = nessuna posizione (chiusa/liquidata): posBase 0, non skip —
    // altrimenti le tranche morte sopravviverebbero e inquinerebbero la prossima.
    const posBase = pos && pos.size != null ? Math.round(Math.abs(Number(pos.size)) * 10 ** mkt.sizeDec) : 0;
    const mark = pos ? markFromPosition(pos, coin.side) : null;

    if (posBase <= 0) {
      // posizione sparita: azzera la contabilita' (il ramo non usa il mark)
      const rec = reconcileTranches(st.perpTranches, 0, 0, mkt.sizeDec);
      if (rec.changed) {
        st.perpTranches = rec.tranches; st.perpOpen = false;
        st.perpTpDeep = 0; st.perpTpSplit = 0;
        // funding the dead position owed died with its margin: it is not the next one's debt
        if (Number(st.perpRealizedUsd) < 0) st.perpRealizedUsd = 0;
        if (!sim) checkpoint();
        console.log(`  [${coin.symbol}] ${tag}tranches: ${rec.note}`);
      } else if (!Number(st.perpWithdrawIntentUsd || 0) && acc.collateral != null && outOfEngine(st) > Number(acc.collateral) + 0.01) {
        // flat, and the cash is all the account has: what the book says left the engine beyond it
        // went with a loss taken since (a netted average, a liquidation). Kept, it would claim new
        // deposits as if they were proceeds. Only when two reads in a row agree.
        if (!shortBefore) { st.perpShortSeen = true; if (!sim) checkpoint(); return; }
        const over = outOfEngine(st) - Number(acc.collateral);
        st.perpCapitalUsd = Number(st.perpCapitalUsd || 0) - over;
        if (st.perpCapitalUsd < 0) { st.perpRealizedUsd = Math.max(0, Number(st.perpRealizedUsd || 0) + st.perpCapitalUsd); st.perpCapitalUsd = 0; }
        if (!sim) checkpoint();
        console.log(`  [${coin.symbol}] ${tag}$${over.toFixed(2)} booked out of the engine are not in the account: written off`);
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
      const { ready, keep } = matureTranches(st.perpTranches, mark, coin.side, st.lighterLeverage ?? coin.leverage, triggerFrac);
      // The price may not go past the entry of the worst of them, so one just at its target can keep
      // the deep ones from closing on a book that would take them: the deepest go first, and how
      // many is found by halving at a refusal and doubling at a fill. Never fewer than make an order
      // the venue takes; at that point it is the size that is halved.
      const minAsk = Math.max(mkt.minBaseUnits || 1, Math.ceil((mkt.minQuoteUsd || 0) / mark * 10 ** mkt.sizeDec));
      const gain = (t) => Math.abs(mark - t.entryMark);
      const deepest = [...ready].sort((a, b) => gain(b) - gain(a));
      let least = 0;
      for (let sum = 0; least < deepest.length && sum < minAsk; least++) sum += deepest[least].base;
      const count = Math.max(least, Number(st.perpTpDeep) > 0 ? Math.min(Number(st.perpTpDeep), deepest.length) : deepest.length);
      const closing = deepest.slice(0, count), rest = keep.concat(deepest.slice(count));
      if (!ready.length && (st.perpTpDeep || st.perpTpSplit)) { st.perpTpDeep = 0; st.perpTpSplit = 0; if (!sim) checkpoint(); }
      const mature = Math.min(closing.reduce((a, t) => a + t.base, 0), posBase);
      const split = Number(st.perpTpSplit || 0);
      let closeBase = split > 0 ? Math.min(mature, Math.max(minAsk, Math.floor(mature / 2 ** split))) : mature;
      if (mature - closeBase < minAsk) closeBase = mature;
      if (ready.length && closeBase >= minAsk) {
        if (sim) {
          console.log(`  [${coin.symbol}] ${tag}TAKE-PROFIT (${tpLabel}): chiuderei ${ready.length} tranche (base ${closeBase}), realizzerei ~$${realizedFromTranches(ready, mark, coin.side, mkt.sizeDec).toFixed(2)}`);
        } else {
          const avgEntry = Number(pos.avg_entry_price);
          const o = recordOrder(st, checkpoint, {
            kind: 'tp', marketIndex, side: coin.side, sizeDec: mkt.sizeDec, base: posBase, ask: closeBase, avgEntry, mark, cash: isolatedCash(acc), tpPct: Math.round(triggerFrac * 100),
            margin: Number(pos.allocated_margin) > 0 ? Number(pos.allocated_margin) : avgEntry * posBase / 10 ** mkt.sizeDec / Number(st.lighterLeverage ?? coin.leverage),
            ready: [...closing].sort((a, b) => a.ts - b.ts), keep: rest, count, of: ready.length,
          });
          try {
            // never past the entry of the worst of them: a book thinner than the gain is not a gain.
            // As a price, not only as a distance: the mark may have moved by the time it is signed
            const worst = closing.reduce((a, t) => (gain(t) < gain(a) ? t : a));
            await lighter.close({ accountIndex, marketIndex, baseAmount: closeBase, isAsk: !isAsk, maxSlippage: Math.min(config.LIGHTER_MAX_SLIPPAGE, 0.9 * gain(worst) / mark), limitPrice: worst.entryMark + 0.1 * (mark - worst.entryMark), clientOrderIndex: o.id, apiPrivKey, apiKeyIndex });
          } catch (e) {
            if (!(e && e.definitive)) throw e; // unknown: settled on its trades, next tick
            st.perpOrder = null;
            if (!e.retry) {
              if (count > least) st.perpTpDeep = Math.max(least, Math.floor(count / 2));
              // as few as they can be: smaller sizes, and after the smallest everything from the start
              else { st.perpTpSplit = split >= 5 ? 0 : split + 1; if (split >= 5) st.perpTpDeep = 0; }
            }
            checkpoint();
            if (e.retry) { e.again = true; throw e; }
            if (split === 0) console.log(`  [${coin.symbol}] TAKE-PROFIT rifiutato (${e.message.slice(0, 100)}): riprovo con size minori`);
          }
          if (st.perpOrder) {
            o.sent = true; o.sentAt = Date.now(); checkpoint();
            await settleOrder({ ...ctx, tries: config.LIGHTER_FILL_TRIES });
            return; // the account has just changed: opening waits for the next read of it
          }
        }
      } else if (ready.length && !sim) {
        // mature ma sotto il minimo d'ordine: restano in lista e si chiudono con le prossime
        if (!st.perpSmallLogged) console.log(`  [${coin.symbol}] ${ready.length} tranche mature sotto il minimo d'ordine (${closeBase} < ${minAsk}): accumulo`);
        st.perpSmallLogged = true;
      }
    }
  }

  // 7) OPEN / TOPUP: deploya il collaterale libero al leverage scelto.
  //    Cio' che e' uscito dal motore con un take-profit (guadagno E capitale) resta fuori
  //    dal deployable: e' in coda per il withdraw (step 8) e va in buyback. Dopo un
  //    take-profit si riapre solo con fee nuove.
  //    Si impiega solo COLLATERAL_HEADROOM del libero: Lighter valuta il margine al
  //    prezzo di esecuzione, quindi senza buffer l'ordine viene scartato in silenzio
  //    appena il prezzo si muove tra la lettura del mark e il fill.
  const usableUsd = Math.max(0, freeCollateralUsd - outOfEngine(st) - Number(st.perpDoubtUsd || 0));
  const deployableUsd = usableUsd * config.COLLATERAL_HEADROOM;
  // one tranche per interval: only finishing one that filled in part does not wait
  const tooSoon = st.perpOpen && !filling(st) && Date.now() - Number(st.perpTrancheAt || 0) < config.TRANCHE_INTERVAL_MS;
  const least = minDeploy(st);
  const minNotional = Math.max(mkt.minQuoteUsd || 0, 0);
  if (st.engineBlocked || venueLeverage == null) {
    // no new exposure: the engine does not fit the venue, or Lighter has no leverage set for it
  } else if (tooSoon || deployableUsd < least) {
    // accumulating
  } else if (deployableUsd * venueLeverage < minNotional) {
    if (!st.perpBelowMinLogged) {
      console.log(`  [${coin.symbol}] collaterale insufficiente per il minimo d'ordine: $${(deployableUsd * venueLeverage).toFixed(2)} di notional < $${minNotional.toFixed(2)} richiesti da ${coin.market} — accumulo`);
      st.perpBelowMinLogged = true; if (!sim) checkpoint();
    }
  } else {
    st.perpBelowMinLogged = false;
    const wasOpen = st.perpOpen;
    // a book too thin refuses it whole: each refusal halves the next, down to the venue's minimum
    const openSplit = Number(st.perpOpenSplit || 0);
    const notionalUsd = Math.max(minNotional, deployableUsd * venueLeverage / 2 ** openSplit);
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}perp ${wasOpen ? 'topup' : 'open'}: aprirei notional $${notionalUsd.toFixed(2)} ${coin.side} ${venueLeverage}x (deployable $${deployableUsd.toFixed(2)}, riservato al withdraw $${outOfEngine(st).toFixed(2)})`);
    } else {
      const base = pos && pos.size != null ? Math.round(Math.abs(Number(pos.size)) * 10 ** mkt.sizeDec) : 0;
      const o = recordOrder(st, checkpoint, { kind: 'open', marketIndex, side: coin.side, sizeDec: mkt.sizeDec, base, avgEntry: pos ? Number(pos.avg_entry_price) : 0, ask: null, split: openSplit, leverage: venueLeverage, minBaseUnits: mkt.minBaseUnits });
      try {
        const r = await lighter.open({ accountIndex, marketIndex, notionalUsd, isAsk, maxSlippage: config.LIGHTER_MAX_SLIPPAGE, clientOrderIndex: o.id, apiPrivKey, apiKeyIndex });
        o.ask = Number(r.baseAmount) || null;
      } catch (e) {
        if (!(e && e.definitive)) throw e;
        st.perpOrder = null; if (!e.retry) st.perpOpenSplit = openSplit >= 6 ? 0 : openSplit + 1; checkpoint();
        if (st.perpOpenRefused !== e.message) console.log(`  [${coin.symbol}] perp open rifiutato: ${e.message.slice(0, 120)}`);
        st.perpOpenRefused = e.message;
        return;
      }
      st.perpOpenRefused = null;
      o.sent = true; o.sentAt = Date.now(); checkpoint();
      await settleOrder({ ...ctx, tries: config.LIGHTER_FILL_TRIES });
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

/**
 * Is there a tranche of this token at its target, at this mark? The alarm behind the live marks:
 * the same rule as the take-profit's, on the state in memory. Nothing is closed on its word.
 */
function hasMature(coin, st, mark) {
  if (!st || config.RETIRED.has(coin.token.toLowerCase()) || config.PAUSED.has(coin.token.toLowerCase()) || coin.engineError) return false;
  // an order in flight or a switch under way has the token already
  if (st.perpOrder || st.perpSwitch || Number(st.perpWithdrawIntentUsd || 0) > 0) return false;
  if (coin.managed && st.perpEngine && (st.perpEngine.market !== coin.market || st.perpEngine.side !== coin.side)) return false;
  const tranches = Array.isArray(st.perpTranches) ? st.perpTranches : [];
  return tranches.length > 0 && matureTranches(tranches, mark, coin.side, st.lighterLeverage ?? coin.leverage, coinTrigger(coin)).ready.length > 0;
}

/**
 * What a round needs to know of every token before going to it, in one read: what waits in its
 * sink and on the hook, and what its wallet holds. null for a token that could not be read.
 */
const PENDING_IFACE = new ethers.utils.Interface(SINK_ABI);
const BALANCE_IFACE = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)']);
async function readBriefs(coins) {
  const calls = [];
  const at = coins.map((coin) => {
    const sub = deriveSubWallet(coin.token, provider).address, first = calls.length;
    calls.push({ target: coin.pair, iface: BALANCE_IFACE, fn: 'balanceOf', args: [sub] }, { target: coin.token, iface: BALANCE_IFACE, fn: 'balanceOf', args: [sub] });
    if (coin.venue === 'v4' && coin.sink) calls.push({ target: coin.sink, iface: PENDING_IFACE, fn: 'pending' }, { target: config.REHYPE, iface: v4.REHYPE_IFACE, fn: 'getHookFees', args: [coin.poolId] });
    return { first, v4: coin.venue === 'v4' && !!coin.sink };
  });
  const rows = await multicall(provider, calls);
  const out = new Map();
  coins.forEach((coin, i) => {
    const [quote, held, pending, hook] = rows.slice(at[i].first, at[i].first + (at[i].v4 ? 4 : 2));
    const bad = !quote || !held || (at[i].v4 && (!pending || !hook));
    out.set(coin.token.toLowerCase(), bad ? null : {
      quoteRaw: BN(quote[0]), coinRaw: BN(held[0]),
      sinkRaw: pending ? BN(pending[0]) : BN(0), sinkCoinRaw: pending ? BN(pending[1]) : BN(0),
      hookRaw: hook ? BN(hook.beneficiaryFees0).add(hook.beneficiaryFees1) : BN(0),
    });
  });
  return out;
}

/**
 * Why a round must go to this token, or null when it has nothing to do. Anything unknown is a
 * reason: going to a token for nothing costs a read, missing one that needed it costs money. And
 * every token is looked at again after a while whatever this says.
 */
function reasonToTick({ coin, st, brief, feedLive, now = Date.now() }) {
  if (config.PAUSED.has(coin.token.toLowerCase())) return null;
  const idle = now - Number(st.perpLookAt || 0) >= config.PERP_LOOK_MS ? 'look' : null;
  const usd = (raw) => usdOf(BN(raw || '0'), coin.pairDecimals, 1);
  if (st.perpOrder || st.txOut || Number(st.perpWithdrawIntentUsd || 0) > 0) return 'in flight';
  if (st.surplusSeen || st.shortSince) return 'books';
  if (!brief) return 'unread';
  if (brief.sinkCoinRaw.gt(0) || usd(brief.sinkRaw) >= config.CLAIM_MIN_USD) return 'fees';
  if (config.RETIRED.has(coin.token.toLowerCase())) return usd(brief.quoteRaw) >= config.CLAIM_MIN_USD || st.perpOpen ? 'retired' : idle;
  if (coin.engineError) return idle;
  if (coin.venue !== 'v4' || !coin.sink || !coin.sinkAdopted) return 'setup';
  if (brief.hookRaw.gt(0)) return 'hook';
  if (brief.coinRaw.gt(0)) return 'burn';
  if (Number(st.perpWithdrawPendingUsd || 0) > 0) return 'arrival';
  if (usd(st.buybackReserveRaw) >= config.BUYBACK_FLOOR_USD) return 'buyback';
  if (usd(st.treasuryOwedRaw) >= config.CREATOR_MIN_PAYOUT_USD || usd(st.creatorOwedRaw) >= config.CREATOR_MIN_PAYOUT_USD) return 'payout';
  const accounted = BN(st.buybackReserveRaw || '0').add(st.creatorOwedRaw || '0').add(st.treasuryOwedRaw || '0').add(st.perpReserveRaw || '0');
  if (brief.quoteRaw.gt(accounted) && usd(brief.quoteRaw.sub(accounted)) >= config.CLAIM_MIN_USD) return 'surplus';
  if (st.lighterAccountIndex == null) return Number(st.perpDepositedUsd || 0) > 0 || depositDue({ coin, st, usd: usd(st.perpReserveRaw), now }) ? 'account' : idle;
  if (depositDue({ coin, st, usd: usd(st.perpReserveRaw), now })) return 'deposit';
  if (Number(st.perpDepositAt || 0) > Number(st.perpTrancheAt || 0) && now - Number(st.perpDepositAt) < 30 * 60 * 1000) return 'deposit on its way';
  if (st.perpSwitch || st.perpCarry || (coin.managed && st.perpEngine && (st.perpEngine.market !== coin.market || st.perpEngine.side !== coin.side))) return 'switch';
  if (filling(st, now) || Number(st.perpOpenSplit || 0) > 0 || Number(st.perpTpSplit || 0) > 0 || Number(st.perpTpDeep || 0) > 0) return 'unfinished';
  if (outOfEngine(st) >= config.PERP_WITHDRAW_FLOOR_USD && now >= Number(st.perpWithdrawRetryAt || 0)) return 'withdrawal';
  if (!st.engineBlocked && st.lighterLeverage !== coin.leverage && st.lighterLeverageRejected !== coin.leverage) return 'leverage';
  // without the live marks the round is the only one that sees a target touched
  if (!feedLive && Array.isArray(st.perpTranches) && st.perpTranches.length) return 'no marks';
  return idle;
}

/** the tokens with an open position, by the venue's market id, for the live marks to look at */
async function urgentEntries(reg, coins) {
  try { await lighter.markets(); } catch { return null; }
  const out = [];
  for (const coin of coins) {
    const st = reg.state[coin.token.toLowerCase()];
    if (!st || !Array.isArray(st.perpTranches) || !st.perpTranches.length) continue;
    try { out.push({ key: coin.token.toLowerCase(), marketId: (await lighter.market(coin.market)).index, coin, st }); }
    catch { /* not listed, or the list could not be read: the round looks at it */ }
  }
  return out;
}

/** the perp half of a tick, for a token a live mark put in front of the others */
async function urgentTick(keeper, entry, checkpoint) {
  const { coin, st } = entry;
  const size = () => (st.perpTranches || []).reduce((a, t) => a + t.base, 0);
  const before = size();
  let again = false;
  try {
    await perpTick(keeper, coin, st, checkpoint, deriveSubWallet(coin.token, provider), priceUsd(coin.pair, coin.pairSymbol), erc20(coin.pair), { urgent: true });
  }
  catch (e) { again = true; console.log(`  [${coin.symbol}] perp: ${e.message.slice(0, 140)}`); }
  checkpoint();
  return { acted: size() !== before || !!st.perpOrder, again };
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
  OPEN_GATE_USD: 25,
  TOPUP_STEP_USD: 25,
  FIRST_OPEN_DELAY_MS: 10 * 60 * 1000,
  TRANCHE_INTERVAL_MS: 60 * 60 * 1000,
  BUYBACK_FLOOR_USD: 20,
  PERP_WITHDRAW_FLOOR_USD: 20,
  MIN_DEPLOY_USD: 2,
};

function warnIfNotProduction() {
  if (config.PAUSED.size) console.log(`paused, left alone: ${[...config.PAUSED].join(', ')}`);
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

  // One registry for the life of the process: a token left behind by a round goes on working on it.
  const store = createStore(registry.load());
  const { reg } = store;
  const lanes = createLanes();
  const keyOf = (coin) => coin.token.toLowerCase();
  const trading = lighter.enabled && !lighter.simulate;

  // reads carry the token of the account they are about: its own 60 a minute, instead of everybody's
  if (trading && config.LIGHTER_AUTH_READS) lighter.useKeys((id) => {
    const st = Object.values(reg.state).find((s) => Number(s.lighterAccountIndex) === Number(id) && s.lighterApiPrivKey);
    if (!st) return null;
    try { return { apiPrivKey: decryptSecret(st.lighterApiPrivKey), apiKeyIndex: st.lighterApiKeyIndex }; } catch { return null; }
  });

  // live marks: a token at its target goes at once, in a lane of its own, whatever the round is doing
  const watching = trading && !flag('once') && !!config.LIGHTER_WS_URL;
  const urgent = createUrgent({ isDue: (e, mark) => hasMature(e.coin, e.st, mark) });
  const feed = watching ? createFeed({ url: config.LIGHTER_WS_URL, onMark: (id, mark) => urgent.onMark(id, mark) }) : null;
  let marketOf = new Map(); // token → the market its position is on
  const urgentLane = async () => {
    for (;;) {
      await urgent.wait(60_000);
      const e = urgent.take();
      if (!e) continue;
      try {
        let acted = false, again = false;
        const went = await lanes.run(e.key, () => lighter.urgently(async () => { ({ acted, again } = await urgentTick(keeper, e, () => store.commit(e.key))); }));
        urgent.served(e.key, { acted, went, again }); // at work already: asked again in a moment
      } catch (err) { urgent.served(e.key, { acted: false, went: true }); console.log(`  [${e.coin.symbol}] urgent: ${String(err.message).slice(0, 140)}`); }
    }
  };
  if (feed) for (let n = 0; n < config.URGENT_PARALLEL; n++) urgentLane();

  do {
    // coin nuove dal router (eventi MultiplyLaunch + metadata IPFS + sink): entrano da sole
    try { await routerCoins.syncRouterCoins(provider, reg, { isBusy: lanes.isBusy }); store.commitCoins(lanes.isBusy); }
    catch (e) { console.log(`  sync router: ${e.message.slice(0, 120)}`); }
    const coins = reg.coins.filter((c) => !only || keyOf(c) === only.toLowerCase());
    if (!coins.length) console.log(ts() + ' nessuna coin nel registry');
    if (feed) {
      const entries = await urgentEntries(reg, coins);
      if (entries) { // the list could not be read: the alarms of the round before stay
        urgent.load(entries);
        marketOf = new Map(entries.map((e) => [e.key, e.marketId]));
        feed.watch(new Set([...marketOf.values(), config.LIGHTER_HEARTBEAT_MARKET]));
      }
    }
    let briefs = null;
    if (trading) try { briefs = await readBriefs(coins); } catch (e) { console.log(`  briefs: ${e.message.slice(0, 100)} (only what is known from the books this round)`); }
    // reasons that are only "go and see": with many tokens they would be the whole round
    const ROUTINE = new Set(['look', 'unread', 'no marks']);
    const inFlight = (c) => (reg.state[keyOf(c)].perpOrder || reg.state[keyOf(c)].txOut || Number(reg.state[keyOf(c)].perpWithdrawIntentUsd || 0) > 0 ? 1 : 0);
    const heard = (c) => !!feed && feed.fresh(marketOf.get(keyOf(c)));
    const looks = [];
    const due = coins.filter((coin) => {
      const st = reg.state[keyOf(coin)];
      if (!st) { console.log(`  [${coin.symbol}] stato mancante nel registry, salto`); return false; }
      if (!trading || flag('once')) return true;
      const why = reasonToTick({ coin, st, brief: briefs && briefs.get(keyOf(coin)), feedLive: heard(coin) });
      if (!why) st.lastTickTs = Date.now();
      else if (ROUTINE.has(why)) looks.push(coin);
      return !!why && !ROUTINE.has(why);
    });
    due.sort((a, b) => inFlight(b) - inFlight(a)); // what is already under way comes first
    // the routine looks come last, a few per round, the longest unseen first: they all cost a read
    looks.sort((a, b) => Number(reg.state[keyOf(a)].perpLookAt || 0) - Number(reg.state[keyOf(b)].perpLookAt || 0));
    // without the live marks they are the only ones that see a target: all the reads there are go to them
    const live = feed && feed.live();
    const most = live ? config.LOOKS_PER_ROUND : Math.max(config.LOOKS_PER_ROUND, lighter.spareReads() - 5);
    const own = [], shared = []; // those read on their own allowance, and those on everybody's
    for (const c of looks) (lighter.authed(reg.state[keyOf(c)].lighterAccountIndex) ? own : shared).push(c);
    due.push(...own.slice(0, config.LOOKS_PER_ROUND * (live ? 3 : 6)), ...shared.slice(0, most));
    await lanes.round(due, {
      key: keyOf, parallel: config.TICK_PARALLEL, patienceMs: config.TICK_PATIENCE_MS,
      work: async (coin) => {
        const commit = () => store.commit(keyOf(coin));
        const book = () => JSON.stringify((reg.state[keyOf(coin)].perpTranches || []).map((t) => t.base));
        const before = book();
        try { await tickCoin(keeper, locker, coin, reg.state[keyOf(coin)], commit); }
        catch (e) { console.log(`  [${coin.symbol}] ERRORE tick: ${e.message.slice(0, 140)}`); }
        // seen, whatever came of it: one that always fails must not keep its place in front
        reg.state[keyOf(coin)].perpLookAt = Date.now();
        if (book() !== before) urgent.served(keyOf(coin), { acted: true, went: true });
        commit();
      },
    });
    if (!only && !lighter.simulate) {
      await lanes.round(['flywheel'], {
        key: (k) => k, parallel: 1, patienceMs: config.TICK_PATIENCE_MS,
        work: async () => {
          try {
            await flywheelTick({
              reg, checkpoint: store.commitRest, provider, wallet: keeper.address, isStuck,
              send: (tx, label, onSigned) => send(keeper, tx, label, onSigned),
              plan: (coin, raw) => buybackPlanV4(keeper, coin, erc20(coin.pair), raw),
              quote: (coin, raw) => v4.quoteExactInV4(provider, { asset: coin.token, numeraire: coin.pair, tokenIn: coin.pair, amountIn: raw }),
            });
          } catch (e) { console.log(`  [flywheel] ${e.message.slice(0, 140)}`); }
          store.commitRest();
        },
      });
    }
    // estratto pubblico per il sito (senza chiavi API ne' stato interno):
    // in produzione il frontend gira su un host remoto e non vede il file locale
    publish.writeSnapshot(store.committed());
    if (!flag('once')) await sleep(config.TICK_MS);
  } while (!flag('once'));
}

if (require.main === module) {
  main().catch((e) => { console.error('Errore fatale:', e.message); process.exit(1); });
}

// helper puri esportati per i test a secco
module.exports = { sweepSurplus, settleWithdrawal, refusedByNode, sendNow, receiptOf, moving, settleTxOut, StuckTxError, readBriefs, reasonToTick, hasMature, strayPositions, closeProceeds, withdrawalOf, splitArrival, settleOrder, retireTick, depositDue, minDeploy, tickCoin, settleEngineSwitch, perpTick, trancheTargetMark, effectiveTrigger, coinTrigger, markFromPosition, reconcileTranches, matureTranches, realizedFromTranches, removeClosedBase, addTranche, fundingDelta, quoteExactInV3, coinValueInQuote, isFeeInflow, lockHolderAlive };
