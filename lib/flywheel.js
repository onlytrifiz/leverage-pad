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
 * A buy and a burn are on disk before they are sent; after a crash they are looked for on-chain by
 * their exact amount before anything is spent again.
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
const LOG_STEP = 400_000;       // the node's window for a filtered query
const LOST_AFTER_MS = 10 * 60 * 1000;
const usd = (raw) => Number(ethers.utils.formatUnits(raw, 6));

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
async function collect({ fw, coins, provider, wallet }) {
  const to = (await provider.getBlockNumber()) - SETTLE_BLOCKS;
  const from = payers(coins);
  let earned = ethers.constants.Zero;
  for (let a = fw.scanBlock + 1; a <= to && from.length; a += LOG_STEP) {
    const logs = await provider.getLogs({ address: config.USDG, fromBlock: a, toBlock: Math.min(to, a + LOG_STEP - 1), topics: [TRANSFER, from.map(topic), topic(wallet)] });
    for (const l of logs) earned = earned.add(BN(l.data));
  }
  if (to > fw.scanBlock) fw.scanBlock = to;
  fw.revenueRaw = BN(fw.revenueRaw).add(earned).toString();
  fw.owedRaw = BN(fw.owedRaw).add(earned.mul(config.FLYWHEEL_SHARE_BPS).div(10000)).toString();
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

/** the transaction that moved exactly `value` of `token` out of the wallet since `fromBlock`, or null */
async function findOut({ provider, token, wallet, value, fromBlock, known }) {
  const logs = await provider.getLogs({ address: token, fromBlock, toBlock: 'latest', topics: [TRANSFER, topic(wallet)] });
  const hit = logs.find((l) => BN(l.data).eq(value) && !known.includes(l.transactionHash));
  return hit ? provider.getTransactionReceipt(hit.transactionHash) : null;
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

  // what was in flight first
  const known = fw.history.flatMap((h) => [h.buyTx, h.burnTx]).filter(Boolean);
  if (fw.buying) {
    const rc = await findOut({ provider, token: config.USDG, wallet, value: fw.buying.spendRaw, fromBlock: fw.buying.fromBlock, known });
    if (rc) { booked(fw, rc, fw.buying.spendRaw, wallet, fw.buying.at); checkpoint(); }
    else if (now - fw.buying.at < LOST_AFTER_MS) return;
    else { fw.owedRaw = BN(fw.owedRaw).add(fw.buying.spendRaw).toString(); fw.buying = null; checkpoint(); log('  [flywheel] a buy that never landed: its USDG is owed again'); }
  }
  if (fw.burning) {
    const rc = await findOut({ provider, token: fw.token, wallet, value: fw.burning.raw, fromBlock: fw.burning.fromBlock, known });
    if (rc) { fw.burnedRaw = BN(fw.burnedRaw).add(fw.burning.raw).toString(); fw.burning = null; checkpoint(); }
    else if (now - fw.burning.at < LOST_AFTER_MS) return;
    else { fw.toBurnRaw = BN(fw.toBurnRaw).add(fw.burning.raw).toString(); fw.burning = null; checkpoint(); }
  }

  const burn = async () => {
    const raw = BN(fw.toBurnRaw);
    if (raw.isZero()) return;
    fw.burning = { raw: raw.toString(), fromBlock: await provider.getBlockNumber(), at: now }; fw.toBurnRaw = '0'; checkpoint();
    let rc;
    try { rc = await send({ to: fw.token, data: ERC20.encodeFunctionData('burn', [raw]), gasLimit: 80000 }, 'flywheel burn'); }
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

  if (now - fw.lastRunAt < config.FLYWHEEL_INTERVAL_MS) return;
  if (config.TREASURY.toLowerCase() !== wallet.toLowerCase()) { once('off: the treasury is not the wallet this keeper signs with'); return; }
  const coin = reg.coins.find((c) => c.token.toLowerCase() === token.toLowerCase());
  if (!coin || coin.venue !== 'v4' || config.RETIRED.has(token.toLowerCase())) { once(`off: ${token} is not a live token of the router`); return; }
  if (!fw.token || fw.token.toLowerCase() !== token.toLowerCase()) {
    // the first time, or another token: the count goes on, only what it buys changes
    fw.token = coin.token;
    if (fw.scanBlock == null) fw.scanBlock = (config.FLYWHEEL_FROM_BLOCK || await provider.getBlockNumber()) - 1;
    checkpoint();
    log(`  [flywheel] on: ${config.FLYWHEEL_SHARE_BPS / 100}% of the protocol's earnings buys ${coin.symbol} ${coin.token} and burns it, every ${config.FLYWHEEL_INTERVAL_MS / 60000} min, counted from block ${fw.scanBlock + 1}`);
  }

  const earned = await collect({ fw, coins: reg.coins, provider, wallet });
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
  fw.buying = { spendRaw: size.amount.toString(), fromBlock: await provider.getBlockNumber(), at: now }; fw.said = null;
  checkpoint();
  let rc;
  try { rc = await send({ to: p.to, data: p.data, gasLimit: p.gasLimit }, 'flywheel buy'); }
  catch (e) {
    if (!isStuck(e)) { fw.owedRaw = BN(fw.owedRaw).add(size.amount).toString(); fw.buying = null; checkpoint(); }
    throw e;
  }
  const bought = booked(fw, rc, size.amount, wallet, now); checkpoint();
  log(`  [flywheel] bought ${ethers.utils.formatEther(bought)} ${coin.symbol} with $${usd(size.amount).toFixed(2)} (impact ${size.impactBps} bps)`);
  await burn();
}

/** what the site may show */
const publicFlywheel = (fw) => fw && fw.token ? { token: fw.token, shareBps: config.FLYWHEEL_SHARE_BPS, revenueRaw: fw.revenueRaw, owedRaw: fw.owedRaw, spentRaw: fw.spentRaw, burnedRaw: fw.burnedRaw, lastRunAt: fw.lastRunAt, history: fw.history } : null;

module.exports = { flywheelTick, publicFlywheel, payers, sizeBuy };
