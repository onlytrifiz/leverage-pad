const { ethers } = require('ethers');
const config = require('../config');

/**
 * The platform's buyback & burn.
 *
 * Of everything the protocol earns (its share of every trading fee, paid by the sinks, and of every
 * take-profit's gain, paid by the keeper), FLYWHEEL_SHARE_BPS buys the platform token on its pool
 * and burns it, every FLYWHEEL_INTERVAL_MS. The rest stays in the treasury wallet.
 *
 * The treasury is also the owner's own wallet, so its balance says nothing: what was earned is
 * counted from the USDG transfers that reach it from the tokens' sinks and sub-wallets, and only
 * those. Off until PERPSPAD_FLYWHEEL_TOKEN is set, and counted from then (or from
 * PERPSPAD_FLYWHEEL_FROM_BLOCK).
 *
 * A buy and a burn are on disk, signed, before they are sent; after a crash or a node that does not
 * answer, the same transaction is looked for, and sent again, before anything else is spent.
 */
const BN = ethers.BigNumber.from;
const ERC20 = new ethers.utils.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function burn(uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const TRANSFER = ERC20.getEventTopic('Transfer');
const topic = (a) => ethers.utils.hexZeroPad(a, 32).toLowerCase();
const SETTLE_BLOCKS = 20;       // behind the head, where every node has answered
const LOG_STEP = 90_000;        // the node's window for a query with several senders is 100,000 blocks
const LOG_SENDERS = 400;        // and it takes 1,000 topics in all
const usd = (raw) => Number(ethers.utils.formatUnits(raw, 6));

const RETRY_NOW_MAX = 3;        // a failed buy is tried again at the next tick this many times in a row, then waits the interval

const EMPTY = { token: null, scanBlock: null, revenueRaw: '0', owedRaw: '0', spentRaw: '0', burnedRaw: '0', toBurnRaw: '0', lastRunAt: 0, buying: null, burning: null, history: [] };

/** who pays the protocol: a retired token's sweep is its own money, not an earning */
function payers(coins) {
  const out = [];
  for (const c of coins) {
    if (config.RETIRED.has(c.token.toLowerCase()) || c.pair.toLowerCase() !== config.USDG.toLowerCase()) continue;
    for (const a of [c.sink, c.subWallet]) if (a && ethers.utils.isAddress(a)) out.push(a.toLowerCase());
  }
  return [...new Set(out)];
}

/** USDG earned since the last look, into what is owed to the buyback */
async function collect({ fw, coins, provider, wallet, checkpoint }) {
  const to = (await provider.getBlockNumber()) - SETTLE_BLOCKS;
  const from = payers(coins);
  let earned = ethers.constants.Zero;
  // each window is counted and remembered on its own: one that cannot be read is where it starts again
  while (fw.scanBlock < to) {
    const end = Math.min(to, fw.scanBlock + LOG_STEP);
    let here = ethers.constants.Zero;
    for (let i = 0; i < from.length; i += LOG_SENDERS) {
      const logs = await provider.getLogs({ address: config.USDG, fromBlock: fw.scanBlock + 1, toBlock: end, topics: [TRANSFER, from.slice(i, i + LOG_SENDERS).map(topic), topic(wallet)] });
      for (const l of logs) here = here.add(BN(l.data));
    }
    fw.scanBlock = end;
    fw.revenueRaw = BN(fw.revenueRaw).add(here).toString();
    fw.owedRaw = BN(fw.owedRaw).add(here.mul(config.FLYWHEEL_SHARE_BPS).div(10000)).toString();
    checkpoint();
    earned = earned.add(here);
  }
  return earned;
}

/** the largest buy, halving from `amount`, that moves the price no more than allowed; null when none does */
async function sizeBuy({ amount, min, quote }) {
  for (let a = BN(amount); a.gte(min); a = a.div(2)) {
    const probe = a.div(100).gt(10_000) ? a.div(100) : BN(10_000);
    const [whole, small] = await Promise.all([quote(a), quote(probe)]);
    if (whole.hookFee > config.FLYWHEEL_MAX_FEE_PIPS) return null; // the launch protection, or a fee nobody should pay
    if (small.out.isZero() || whole.out.isZero()) return null;
    const fair = small.out.mul(a).div(probe);
    const impactBps = fair.gt(whole.out) ? fair.sub(whole.out).mul(10000).div(fair).toNumber() : 0;
    if (impactBps <= config.FLYWHEEL_MAX_IMPACT_BPS) return { amount: a, impactBps };
  }
  return null;
}

/** tokens a transaction delivered to the wallet, from its own logs: the wallet may hold others */
const received = (rc, token, wallet) => rc.logs
  .filter((l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2].toLowerCase() === topic(wallet))
  .reduce((a, l) => a.add(BN(l.data)), ethers.constants.Zero);

/**
 * What came of a transaction, by its hash: its receipt, 'lost' when it cannot happen any more (its
 * nonce was used by another, seen twice a minute apart), or null while it is not known. One that
 * was never signed is lost.
 */
async function outcome({ provider, wallet, tx, checkpoint, now }) {
  if (!tx.hash) return 'lost';
  const rc = await provider.getTransactionReceipt(tx.hash);
  if (rc && rc.blockNumber != null) return rc.status === 1 ? rc : 'lost';
  if (await provider.getTransactionCount(wallet, 'latest') > tx.nonce) {
    if (!tx.usedAt) { tx.usedAt = now; checkpoint(); return null; }
    return now - tx.usedAt >= 60_000 ? 'lost' : null;
  }
  try { await provider.sendTransaction(tx.raw); } catch { /* it has it, or will have it */ }
  return null;
}

function booked(fw, rc, spendRaw, wallet, at) {
  const bought = received(rc, fw.token, wallet);
  fw.buying = null;
  fw.spentRaw = BN(fw.spentRaw).add(spendRaw).toString();
  fw.toBurnRaw = BN(fw.toBurnRaw).add(bought).toString();
  fw.history = [{ at, usd: usd(spendRaw), tokens: ethers.utils.formatEther(bought), buyTx: rc.transactionHash, burnTx: null }, ...fw.history].slice(0, 50);
  return bought;
}

/**
 * One pass, called at the end of every tick.
 * `send(tx, label)` returns a receipt or throws; `isStuck(e)` says the transaction may still mine;
 * `plan(coin, spendRaw)` is the swap; `quote(coin, amountRaw)` is { out, hookFee }.
 */
async function flywheelTick({ reg, checkpoint, provider, wallet, send, isStuck, plan, quote, now = Date.now(), log = console.log }) {
  const token = config.FLYWHEEL_TOKEN;
  if (!token) return;
  const fw = reg.flywheel = { ...EMPTY, ...(reg.flywheel || {}) };
  const once = (msg) => { if (fw.said !== msg) { fw.said = msg; log(`  [flywheel] ${msg}`); } };
  // a buy that failed is tried again at once, with a new quote: a few times, then at the usual pace
  const failed = () => { fw.failStreak = (fw.failStreak || 0) + 1; fw.retryNow = fw.failStreak <= RETRY_NOW_MAX; };

  // what was in flight first
  const seen = async (tx) => outcome({ provider, wallet, tx, checkpoint, now });
  if (fw.buying) {
    const rc = await seen(fw.buying);
    if (!rc) return;
    if (rc !== 'lost') { booked(fw, rc, fw.buying.spendRaw, wallet, fw.buying.at); fw.failStreak = 0; }
    else { fw.owedRaw = BN(fw.owedRaw).add(fw.buying.spendRaw).toString(); fw.buying = null; failed(); log('  [flywheel] a buy that never happened: its USDG is owed again'); }
    checkpoint();
  }
  if (fw.burning) {
    const rc = await seen(fw.burning);
    if (!rc) return;
    if (rc !== 'lost') { fw.burnedRaw = BN(fw.burnedRaw).add(fw.burning.raw18).toString(); if (fw.history[0] && !fw.history[0].burnTx) fw.history[0].burnTx = rc.transactionHash; }
    else fw.toBurnRaw = BN(fw.toBurnRaw).add(fw.burning.raw18).toString();
    fw.burning = null; checkpoint();
  }

  const burn = async () => {
    const raw = BN(fw.toBurnRaw);
    if (raw.isZero()) return;
    fw.burning = { raw18: raw.toString(), at: now }; fw.toBurnRaw = '0'; checkpoint();
    let rc;
    try { rc = await send({ to: fw.token, data: ERC20.encodeFunctionData('burn', [raw]), gasLimit: 80000 }, 'flywheel burn', (s) => { Object.assign(fw.burning, s); checkpoint(); }); }
    catch (e) {
      if (!isStuck(e)) { fw.toBurnRaw = raw.toString(); fw.burning = null; checkpoint(); }
      throw e;
    }
    fw.burning = null; fw.burnedRaw = BN(fw.burnedRaw).add(raw).toString();
    if (fw.history[0] && !fw.history[0].burnTx) fw.history[0].burnTx = rc.transactionHash;
    checkpoint();
    log(`  [flywheel] burned ${ethers.utils.formatEther(raw)} ${fw.token}`);
  };
  await burn();

  if (!fw.retryNow && now - fw.lastRunAt < config.FLYWHEEL_INTERVAL_MS) return;
  fw.retryNow = false;
  if (config.TREASURY.toLowerCase() !== wallet.toLowerCase()) { once('off: the treasury is not the wallet this keeper signs with'); return; }
  const coin = reg.coins.find((c) => c.token.toLowerCase() === token.toLowerCase());
  // a retired token still has its pool: it can be bought, and burned
  if (!coin || coin.venue !== 'v4') { once(`off: ${token} is not a v4 token of the router`); return; }
  if (!fw.token || fw.token.toLowerCase() !== token.toLowerCase()) {
    // the first time, or another token: the count goes on, only what it buys changes
    fw.token = coin.token;
    if (fw.scanBlock == null) fw.scanBlock = (config.FLYWHEEL_FROM_BLOCK || await provider.getBlockNumber()) - 1;
    checkpoint();
    log(`  [flywheel] on: ${config.FLYWHEEL_SHARE_BPS / 100}% of the protocol's earnings buys ${coin.symbol} ${coin.token} and burns it, every ${config.FLYWHEEL_INTERVAL_MS / 60000} min, counted from block ${fw.scanBlock + 1}`);
  }

  const earned = await collect({ fw, coins: reg.coins, provider, wallet, checkpoint });
  fw.lastRunAt = now; checkpoint();
  if (earned.gt(0)) log(`  [flywheel] earned $${usd(earned).toFixed(2)}, $${usd(fw.owedRaw).toFixed(2)} waits for the buyback`);

  const balance = BN(await provider.call({ to: config.USDG, data: ERC20.encodeFunctionData('balanceOf', [wallet]) }));
  const max = BN(Math.round(config.FLYWHEEL_MAX_USD * 1e6));
  let amount = BN(fw.owedRaw);
  if (balance.lt(amount)) { once(`the wallet holds $${usd(balance).toFixed(2)}, $${usd(amount).toFixed(2)} is owed to the buyback`); amount = balance; }
  if (amount.gt(max)) amount = max;
  const min = BN(Math.round(config.FLYWHEEL_MIN_USD * 1e6));
  if (amount.lt(min)) return;
  const size = await sizeBuy({ amount, min, quote: (a) => quote(coin, a) });
  if (!size) { once(`$${usd(amount).toFixed(2)} waits: no buy within ${config.FLYWHEEL_MAX_IMPACT_BPS / 100}% of impact`); return; }

  const p = await plan(coin, size.amount);
  fw.owedRaw = BN(fw.owedRaw).sub(size.amount).toString();
  fw.buying = { spendRaw: size.amount.toString(), at: now }; fw.said = null;
  checkpoint();
  let rc;
  try { rc = await send({ to: p.to, data: p.data, gasLimit: p.gasLimit }, 'flywheel buy', (s) => { Object.assign(fw.buying, s); checkpoint(); }); }
  catch (e) {
    if (!isStuck(e)) { fw.owedRaw = BN(fw.owedRaw).add(size.amount).toString(); fw.buying = null; failed(); checkpoint(); }
    throw e;
  }
  const bought = booked(fw, rc, size.amount, wallet, now); fw.failStreak = 0; checkpoint();
  log(`  [flywheel] bought ${ethers.utils.formatEther(bought)} ${coin.symbol} with $${usd(size.amount).toFixed(2)} (impact ${size.impactBps} bps)`);
  await burn();
}

/** what the site may show */
const publicFlywheel = (fw) => fw && fw.token ? { token: fw.token, shareBps: config.FLYWHEEL_SHARE_BPS, revenueRaw: fw.revenueRaw, owedRaw: fw.owedRaw, spentRaw: fw.spentRaw, burnedRaw: fw.burnedRaw, lastRunAt: fw.lastRunAt, history: fw.history } : null;

module.exports = { flywheelTick, publicFlywheel, payers, sizeBuy };
