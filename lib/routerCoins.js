const { ethers } = require('ethers');
const config = require('../config');
const { validateEngineParams, validateTuning, legacyTakeProfitPct } = require('./launchParams');
const { deriveSubWallet } = require('./subwallet');
const { STATE_DEFAULTS } = require('./registry');

/**
 * routerCoins.js — the coins the keeper serves, read from the chain and nothing else.
 *
 * Nobody registers a coin by hand any more: the launch is a transaction the launcher signs
 * on the MultiplyLaunchRouter, and everything the keeper needs is in that transaction's
 * logs: `MultiplyLaunch` (token, pool id, fee) and `MultiplyEngine` (market, side, leverage,
 * take-profit, managed, creator). Leverage and take-profit can change later (a managed coin's
 * creator after a notice, or the router owner), so every tick also re-reads `engineOf` for the
 * coins already known: the launch event is the first value, not the current one. The router validates the engine in the same ranges the keeper accepts, so a coin
 * that exists has an engine; the metadata on IPFS is for logos and terminals, and the keeper
 * never reads it. No gateway in the loop, nothing to retry.
 *
 * The registry keeps being the keeper's state file: this module only ADDS coins to it, in
 * the same shape the V3 launcher used plus `venue: 'v4'`, `poolId`, `sink`. The five V3
 * coins already there keep their own path.
 */

const ROUTER_IFACE = new ethers.utils.Interface([
  'event MultiplyLaunch(address indexed asset, address indexed launcher, bytes32 indexed poolId, uint24 fee, bool antiSnipe, uint256 mcap, int24 tick, uint128 firstBuy, uint128 firstBuyOut, string tokenURI)',
  'event MultiplyEngine(address indexed asset, string market, uint8 side, uint8 leverage, uint16 takeProfitPct, bool managed, address indexed creator)',
  'event EngineProposed(address indexed asset, uint8 leverage, uint16 takeProfitPct, uint64 effectiveAt)',
  'event EngineProposalCancelled(address indexed asset, address indexed by)',
  'event EngineOverridden(address indexed asset, uint8 leverage, uint16 takeProfitPct, address indexed by)',
  'event FeeSink(address indexed asset, address indexed sink)',
  'function sinkOf(address asset) view returns (address)',
  'function engineOf(address asset) view returns (tuple(string market, uint8 side, uint8 leverage, uint16 takeProfitPct, bool managed, address creator, uint8 pendingLeverage, uint16 pendingTakeProfitPct, uint64 pendingAt))',
  'function engineConfig() view returns (tuple(uint64 leverageMask, uint16 minTakeProfitPct, uint16 maxTakeProfitPct, uint32 managedDelay))',
  'function keeper() view returns (address)',
]);
const ERC20_IFACE = new ethers.utils.Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);

const SCAN_CHUNK = 400_000;
const SIDES = ['long', 'short'];

// ── pure ────────────────────────────────────────────────────────────────────

/** the MultiplyLaunch log → a plain launch record (no I/O) */
function parseLaunchLog(log) {
  const ev = ROUTER_IFACE.parseLog(log);
  const a = ev.args;
  return {
    token: ethers.utils.getAddress(a.asset),
    launcher: ethers.utils.getAddress(a.launcher),
    poolId: String(a.poolId),
    fee: Number(a.fee),
    antiSnipe: Boolean(a.antiSnipe),
    mcapRaw: a.mcap.toString(),
    tick: Number(a.tick),
    firstBuyRaw: a.firstBuy.toString(),
    tokenURI: String(a.tokenURI),
    launchBlock: log.blockNumber,
    txHash: log.transactionHash,
  };
}

/** the MultiplyEngine log → { token, market, side, leverage, takeProfitPct, managed, creator } */
function parseEngineLog(log) {
  const a = ROUTER_IFACE.parseLog(log).args;
  return {
    token: ethers.utils.getAddress(a.asset),
    market: String(a.market),
    side: SIDES[Number(a.side)] ?? null,
    leverage: Number(a.leverage),
    takeProfitPct: Number(a.takeProfitPct),
    managed: Boolean(a.managed),
    creator: ethers.utils.getAddress(a.creator),
  };
}

/**
 * Pairs every launch with its engine event (same asset) and runs the ENGINE fields through the
 * keeper's own validation: the router already enforces these ranges, so a failure here means
 * the two disagree and the coin must not be served until someone looks. Name and ticker are
 * not part of it: they are whatever the token says, and never a reason to refuse a coin.
 */
function engineFor(launch, engineEv) {
  if (!engineEv) return { ok: false, error: 'no MultiplyEngine event for this launch' };
  try {
    const p = validateEngineParams({
      market: engineEv.market, side: engineEv.side, leverage: engineEv.leverage,
      takeProfitPct: engineEv.takeProfitPct, managed: engineEv.managed,
      creator: engineEv.creator || launch.launcher,
    });
    return { ok: true, params: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** the coin record the registry stores */
function toCoinRecord(launch, engine, sink, { chainName, chainSymbol } = {}) {
  const subWallet = deriveSubWallet(launch.token).address;
  const base = {
    venue: 'v4',
    token: launch.token,
    name: chainName || '', symbol: chainSymbol || '',
    pair: config.USDG, pairSymbol: 'USDG', pairDecimals: 6,
    fee: launch.fee, // hook fee, pips (1e6 = 100%)
    poolId: launch.poolId,
    sink: sink || null,
    sinkAdopted: false,
    launcher: launch.launcher,
    subWallet,
    tokenURI: launch.tokenURI,
    initialSupply: Number(ethers.utils.formatUnits(config.V4_SUPPLY_RAW, 18)),
    launchBlock: launch.launchBlock,
    createdAt: new Date().toISOString(),
  };
  if (engine.ok) {
    const p = engine.params;
    return {
      ...base, creator: p.creator, market: p.market, side: p.side, leverage: p.leverage,
      takeProfitPct: p.takeProfitPct, managed: p.managed, pendingEngine: null, engineError: null,
    };
  }
  return {
    ...base, creator: launch.launcher, market: null, side: null, leverage: 0,
    takeProfitPct: null, managed: false, pendingEngine: null, engineError: engine.error,
  };
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/** the node refused the block span (Robinhood's RPC: 400k blocks per query, 100k with OR-topics) */
const isRangeError = (e) => /spans|block range|too many blocks|range is too|limit exceeded/i.test(String((e && (e.body || e.message)) || ''));

/**
 * Every MultiplyLaunch between the two blocks, each with its MultiplyEngine, in RPC-sized chunks.
 *
 * The query asks for the router's logs by ADDRESS only and filters the topics here: the node
 * allows 400k blocks for a plain query but only 100k with an OR on topic0, and the router emits
 * a handful of events. If the node still refuses a span, the chunk halves and the same window
 * is retried, so a stricter RPC slows the scan down instead of stopping discovery.
 */
async function scanLaunches(provider, fromBlock, toBlock, { chunk = SCAN_CHUNK, minChunk = 1_000 } = {}) {
  const launchTopic = ROUTER_IFACE.getEventTopic('MultiplyLaunch');
  const engineTopic = ROUTER_IFACE.getEventTopic('MultiplyEngine');
  const out = [];
  let size = chunk;
  for (let from = fromBlock; from <= toBlock;) {
    const to = Math.min(toBlock, from + size - 1);
    let logs;
    try {
      logs = await provider.getLogs({ address: config.LAUNCH_ROUTER, fromBlock: from, toBlock: to });
    } catch (e) {
      if (isRangeError(e) && size > minChunk) { size = Math.max(minChunk, Math.floor(size / 2)); continue; }
      throw e;
    }
    // MultiplyLaunch and MultiplyEngine are emitted in the same transaction, so always in the same window
    const engines = new Map();
    for (const l of logs) if (l.topics[0] === engineTopic) { const e = parseEngineLog(l); engines.set(e.token.toLowerCase(), e); }
    for (const l of logs) if (l.topics[0] === launchTopic) { const launch = parseLaunchLog(l); out.push({ ...launch, engine: engines.get(launch.token.toLowerCase()) || null }); }
    from = to + 1;
  }
  return out;
}

/** the coin's sink from the router; null when the router predates sinks (call reverts) */
async function sinkOf(provider, token) {
  try {
    const router = new ethers.Contract(config.LAUNCH_ROUTER, ROUTER_IFACE, provider);
    const s = await router.sinkOf(token);
    return ethers.BigNumber.from(s).isZero() ? null : ethers.utils.getAddress(s);
  } catch {
    return null;
  }
}

/**
 * Brings the registry up to date with the router: new launches become coins, coins recorded
 * without a sink get it as soon as the router answers. Mutates `reg`; the caller saves.
 * Returns the number of coins added.
 */
async function syncRouterCoins(provider, reg, { log = console.log } = {}) {
  if (!config.LAUNCH_ROUTER) return 0;
  const latest = await provider.getBlockNumber();
  const from = Number(reg.routerScanBlock ?? config.ROUTER_DEPLOY_BLOCK - 1) + 1;
  let added = 0;
  if (latest >= from) {
    const launches = await scanLaunches(provider, from, latest);
    // a launch whose token does not answer name()/symbol() this tick (RPC hiccup) is not
    // recorded with placeholders: the scan cursor stays before it and it is retried next tick
    let retryFrom = null;
    for (const launch of launches) {
      if (reg.coins.some((c) => c.token.toLowerCase() === launch.token.toLowerCase())) continue;
      const tokenC = new ethers.Contract(launch.token, ERC20_IFACE, provider);
      const [sink, chainName, chainSymbol] = await Promise.all([
        sinkOf(provider, launch.token),
        tokenC.name().catch(() => null),
        tokenC.symbol().catch(() => null),
      ]);
      if (chainName == null || chainSymbol == null) {
        log(`  [${launch.token.slice(0, 10)}] token name/symbol not readable this tick: retrying next tick`);
        if (retryFrom == null || launch.launchBlock < retryFrom) retryFrom = launch.launchBlock;
        continue;
      }
      const engine = engineFor(launch, launch.engine);
      const coin = toCoinRecord(launch, engine, sink, { chainName, chainSymbol });
      reg.coins.push(coin);
      reg.state[coin.token.toLowerCase()] = { ...STATE_DEFAULTS };
      added++;
      log(`  [${coin.symbol || coin.token.slice(0, 10)}] new coin from the router (block ${launch.launchBlock})${engine.ok ? `: ${coin.market} ${coin.side} ${coin.leverage}x +${coin.takeProfitPct}%${coin.managed ? ' managed' : ''}` : ' — engine invalid: ' + engine.error}${sink ? '' : ' — no sink on the router yet'}`);
    }
    reg.routerScanBlock = retryFrom == null ? latest : retryFrom - 1;
  }
  // coins recorded before the router had sinks: pick the sink up when it appears
  for (const coin of reg.coins) {
    if (coin.venue !== 'v4' || coin.sink) continue;
    const s = await sinkOf(provider, coin.token);
    if (s) { coin.sink = s; log(`  [${coin.symbol}] sink found on the router: ${s}`); }
  }
  // the engine as it stands now: a creator's change that became due, or an owner override,
  // reaches the keeper within a tick. Failures are per coin and never stop the sync.
  try { await refreshEngines(provider, reg, { log }); }
  catch (e) { log(`  engine refresh: ${String(e.message).slice(0, 120)}`); }
  return added;
}

// last message logged per coin by refreshEngines: a router that keeps answering the same bad
// value (or a pre-upgrade router without engineOf) is reported once, not every 15 seconds
const engineLogged = new Map();
function logEngineOnce(log, token, key, msg) {
  const k = token.toLowerCase();
  if (engineLogged.get(k) === key) return;
  engineLogged.set(k, key);
  log(msg);
}

/**
 * Re-reads `engineOf` for every router coin with a valid engine and brings the record up to
 * date: current leverage and take-profit, plus the announced change still in its notice period
 * (`pendingEngine`, unix seconds), which the site shows to holders. Market and side never
 * change on-chain, so they are not touched. A value outside the keeper's own rules (should be
 * impossible: the router validates) is logged and not applied: the coin keeps running on the
 * last good engine. Returns the number of coins whose engine changed. Mutates `reg`.
 */
async function refreshEngines(provider, reg, { log = console.log } = {}) {
  if (!config.LAUNCH_ROUTER) return 0;
  const router = new ethers.Contract(config.LAUNCH_ROUTER, ROUTER_IFACE, provider);
  let changed = 0;
  for (const coin of reg.coins) {
    if (coin.venue !== 'v4' || coin.engineError) continue;
    const label = coin.symbol || coin.token.slice(0, 10);
    let e;
    try {
      e = await router.engineOf(coin.token);
    } catch (err) {
      logEngineOnce(log, coin.token, 'read', `  [${label}] engineOf not readable: ${String(err.message).slice(0, 80)} (keeping the recorded engine)`);
      continue;
    }
    if (ethers.BigNumber.from(e.creator).isZero()) continue; // not launched through this router
    const leverage = Number(e.leverage), takeProfitPct = Number(e.takeProfitPct);
    try {
      validateTuning(leverage, takeProfitPct);
    } catch (err) {
      logEngineOnce(log, coin.token, `bad:${leverage}:${takeProfitPct}`, `  [${label}] router engine ${leverage}x +${takeProfitPct}% rejected (${err.message}): keeping ${coin.leverage}x +${coin.takeProfitPct ?? legacyTakeProfitPct(coin.riskProfile)}%`);
      continue;
    }
    engineLogged.delete(coin.token.toLowerCase());
    const prevTp = coin.takeProfitPct ?? legacyTakeProfitPct(coin.riskProfile);
    if (leverage !== coin.leverage || takeProfitPct !== prevTp) {
      // tranches opened before this change keep the leverage they were opened at: their
      // target is a move on THEIR collateral, which the new engine does not reprice
      const st = reg.state && reg.state[coin.token.toLowerCase()];
      if (st && Array.isArray(st.perpTranches) && leverage !== coin.leverage) {
        for (const t of st.perpTranches) if (t.leverage == null) t.leverage = coin.leverage;
      }
      log(`  [${label}] engine changed: ${coin.leverage}x → ${leverage}x, +${prevTp}% → +${takeProfitPct}%`);
      changed++;
    }
    coin.leverage = leverage;
    coin.takeProfitPct = takeProfitPct;
    coin.managed = Boolean(e.managed);
    const pendingAt = Number(e.pendingAt);
    coin.pendingEngine = pendingAt > 0
      ? { leverage: Number(e.pendingLeverage), takeProfitPct: Number(e.pendingTakeProfitPct), effectiveAt: pendingAt }
      : null;
  }
  return changed;
}

module.exports = { ROUTER_IFACE, SIDES, parseLaunchLog, parseEngineLog, engineFor, toCoinRecord, scanLaunches, sinkOf, syncRouterCoins, refreshEngines, SCAN_CHUNK };
