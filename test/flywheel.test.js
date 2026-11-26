const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const config = require('../config');
const { flywheelTick, payers, publicFlywheel } = require('../lib/flywheel');

/** A chain in a list of transfers: enough to earn, buy, burn, crash and look again. */
const BN = ethers.BigNumber.from;
const W = '0x23Bf247B662EFADf114642A65DbbB0CB7D0EBAc0', TOKEN = '0x' + 'aa'.repeat(20), SINK = '0x' + 'b1'.repeat(20), SUB = '0x' + 'b2'.repeat(20), PM = '0x' + 'cc'.repeat(20), ZERO = ethers.constants.AddressZero;
const TRANSFER = ethers.utils.id('Transfer(address,address,uint256)');
const t = (a) => ethers.utils.hexZeroPad(a, 32).toLowerCase();
Object.assign(config, { FLYWHEEL_TOKEN: TOKEN, TREASURY: W, FLYWHEEL_FROM_BLOCK: 0 });

function world({ impact = 0, hookFee = 20000, wallet = 1_000e6 } = {}) {
  const w = { block: 1000, logs: [], sends: [], now: 1_800_000_000_000, nonce: 0, mined: new Map(), repeated: [], usdg: wallet, reg: { coins: [{ token: TOKEN, symbol: 'MULTIPLY', pair: config.USDG, venue: 'v4', sink: SINK, subWallet: SUB }], state: {} }, disk: null, log: [] };
  const put = (token, from, to, value, hash) => w.logs.push({ address: token, blockNumber: w.block, transactionHash: hash, topics: [TRANSFER, t(from), t(to)], data: ethers.utils.hexZeroPad(BN(value).toHexString(), 32) });
  w.pay = (from, value) => { w.block += 1; put(config.USDG, from, W, value, '0xpay' + w.logs.length); w.block += 50; };
  const has = (x, v) => x == null || (Array.isArray(x) ? x.includes(v) : x === v);
  w.provider = {
    getBlockNumber: async () => w.block,
    getLogs: async (f) => w.logs.filter((l) => l.address.toLowerCase() === f.address.toLowerCase() && l.blockNumber >= f.fromBlock && (f.toBlock === 'latest' || l.blockNumber <= f.toBlock) && f.topics.every((x, i) => has(x, l.topics[i]))),
    getTransactionReceipt: async (h) => w.mined.get(h) ?? null,
    getTransactionCount: async () => w.nonce,
    sendTransaction: async (raw) => { w.repeated.push(raw); },
    call: async () => ethers.utils.hexZeroPad(BN(w.usdg).toHexString(), 32),
  };
  w.sign = (tx, label) => ({ hash: '0x' + label.replace(' ', '') + w.nonce, nonce: w.nonce, raw: `raw:${w.nonce}` });
  w.mine = (tx, label) => {
    w.block += 1;
    const { hash } = w.sign(tx, label);
    w.nonce++;
    if (label === 'flywheel buy') { put(config.USDG, W, PM, tx.data, hash); put(TOKEN, PM, W, BN(tx.data).mul(1e12), hash); w.usdg -= Number(tx.data); }
    else put(TOKEN, W, ZERO, '0x' + tx.data.slice(10), hash);
    w.sends.push(label);
    const rc = { status: 1, blockNumber: w.block, transactionHash: hash, logs: w.logs.filter((l) => l.transactionHash === hash) };
    w.mined.set(hash, rc);
    return rc;
  };
  w.send = async (tx, label, onSigned) => { onSigned(w.sign(tx, label)); return w.mine(tx, label); };
  w.run = () => flywheelTick({
    reg: w.reg, checkpoint: () => { w.disk = JSON.parse(JSON.stringify(w.reg)); }, provider: w.provider, wallet: W, now: w.now, log: (m) => w.log.push(m),
    send: (tx, label, onSigned) => w.send(tx, label, onSigned), isStuck: (e) => !!e.stuck,
    plan: async (_, raw) => ({ to: PM, data: raw.toHexString(), gasLimit: 1 }),
    quote: async (_, a) => ({ hookFee, out: BN(a).mul(1e12).mul(1_000_000 - Math.floor(impact * a.toNumber() / 1e6)).div(1_000_000) }),
  });
  w.later = (min = 30) => { w.now += min * 60_000; w.block += 50; return w.run(); };
  w.reborn = () => { w.reg = JSON.parse(JSON.stringify(w.disk)); };
  return w;
}

test('off without a token, or with one the router does not know, or when the treasury is another wallet', async () => {
  const w = world();
  config.FLYWHEEL_TOKEN = ''; await w.run(); assert.equal(w.reg.flywheel, undefined);
  config.FLYWHEEL_TOKEN = '0x' + 'dd'.repeat(20); await w.run(); assert.match(w.log[0], /not a v4 token/);
  config.FLYWHEEL_TOKEN = TOKEN;
  config.TREASURY = SUB; await w.run(); assert.match(w.log[1], /treasury/);
  config.TREASURY = W; assert.deepEqual(w.sends, []);
});

test('70% of what sinks and sub-wallets paid buys and burns; anything else that reaches the wallet is not an earning', async () => {
  const w = world();
  w.pay(SINK, 999e6); // before it was switched on
  await w.run(); assert.deepEqual(w.sends, []);
  w.pay(SINK, 20e6); w.pay(SUB, 10e6); w.pay('0x' + 'ee'.repeat(20), 500e6);
  await w.later();
  assert.deepEqual(w.sends, ['flywheel buy', 'flywheel burn']);
  assert.deepEqual([w.reg.flywheel.revenueRaw, w.reg.flywheel.spentRaw, w.reg.flywheel.owedRaw, w.reg.flywheel.toBurnRaw], ['30000000', '21000000', '0', '0']);
  assert.equal(w.reg.flywheel.burnedRaw, BN(21e6).mul(1e12).toString());
  await w.later(); assert.equal(w.sends.length, 2, 'once');
  assert.equal(publicFlywheel(w.reg.flywheel).history[0].usd, 21);
});

test('every 5 minutes, from $5 up, and what is below waits', async () => {
  const w = world();
  await w.run(); w.pay(SINK, 7e6); await w.later(); assert.equal(w.sends.length, 0);
  w.pay(SINK, 1e6); await w.later(4); assert.equal(w.sends.length, 0);
  await w.later(1); assert.equal(w.sends.length, 2);
  assert.equal(w.reg.flywheel.spentRaw, '5600000');
});

test('a buy never moves the price more than allowed, nor runs into the launch fee, nor past its cap', async () => {
  const thin = world({ impact: 400 }); // 0.04% per dollar
  await thin.run(); thin.pay(SINK, 100e6); await thin.later();
  assert.equal(thin.reg.flywheel.spentRaw, '17500000'); assert.equal(thin.reg.flywheel.owedRaw, '52500000');
  const worse = world({ impact: 10_000 }); await worse.run(); worse.pay(SINK, 100e6); await worse.later(); assert.equal(worse.sends.length, 0);
  const guarded = world({ hookFee: 800_000 }); await guarded.run(); guarded.pay(SINK, 100e6); await guarded.later(); assert.equal(guarded.sends.length, 0);
  const rich = world({ wallet: 5_000e6 }); await rich.run(); rich.pay(SINK, 2_000e6); await rich.later(); assert.equal(rich.reg.flywheel.spentRaw, '500000000');
  const poor = world({ wallet: 8e6 }); await poor.run(); poor.pay(SINK, 100e6); await poor.later(); assert.equal(poor.reg.flywheel.spentRaw, '8000000');
});

test('killed, or left without an answer, around the buy or the burn: spent once, burned once', async () => {
  for (const label of ['flywheel buy', 'flywheel burn']) for (const when of ['before signing', 'mined', 'late', 'never']) {
    const w = world();
    await w.run(); w.pay(SINK, 100e6);
    let parked = null;
    w.send = async (tx, l, onSigned) => {
      if (l !== label) { onSigned(w.sign(tx, l)); return w.mine(tx, l); }
      if (when !== 'before signing') onSigned(w.sign(tx, l));
      if (when === 'mined') w.mine(tx, l); else parked = [tx, l];
      const e = new Error('no answer'); e.stuck = true; throw e;
    };
    await w.later().catch(() => {}); w.reborn();
    w.send = async (tx, l, onSigned) => { onSigned(w.sign(tx, l)); return w.mine(tx, l); };
    await w.later(1);
    if (when === 'late') { assert.equal(w.sends.filter((x) => x === label).length, 0, 'nothing new while it is not known'); assert.ok(w.repeated.length, 'the same one is sent again'); w.mine(...parked); }
    if (when === 'never') { w.nonce++; await w.later(1); await w.later(1); } // something else used its nonce
    await w.later(1); await w.later(30); await w.later(30);
    assert.deepEqual(w.sends, ['flywheel buy', 'flywheel burn'], `${label} ${when}`);
    assert.deepEqual([w.reg.flywheel.spentRaw, w.reg.flywheel.owedRaw, w.reg.flywheel.burnedRaw], ['70000000', '0', BN(70e6).mul(1e12).toString()], `${label} ${when}`);
  }
});

test('a long silence is read in the windows the node takes, and an unreadable one is where it starts again', async () => {
  const w = world();
  await w.run();
  const asked = [], real = w.provider.getLogs;
  w.provider.getLogs = async (f) => { if (f.topics[1]?.length > 1) { asked.push([f.fromBlock, f.toBlock]); if (asked.length === 3) throw new Error('503'); } return real(f); };
  w.pay(SINK, 10e6); w.block += 85_000; w.pay(SINK, 20e6); w.block += 100_000; w.pay(SINK, 40e6); w.block += 50;
  await assert.rejects(w.later());
  assert.equal(w.disk.flywheel.revenueRaw, '30000000');
  assert.ok(asked.every(([a, b]) => b - a < 100_000));
  await w.later(1); await w.later(30);
  assert.equal(w.reg.flywheel.revenueRaw, '70000000');
});

test('hundreds of tokens: the senders are asked a few at a time', async () => {
  const w = world();
  for (let i = 1; i < 700; i++) w.reg.coins.push({ token: ethers.utils.hexZeroPad(ethers.utils.hexlify(i), 20), pair: config.USDG, venue: 'v4', sink: ethers.utils.hexZeroPad(ethers.utils.hexlify(10_000 + i), 20), subWallet: ethers.utils.hexZeroPad(ethers.utils.hexlify(20_000 + i), 20) });
  await w.run();
  const sizes = [], real = w.provider.getLogs;
  w.provider.getLogs = async (f) => { if (Array.isArray(f.topics[1])) sizes.push(f.topics[1].length); return real(f); };
  w.pay(w.reg.coins[650].sink, 9e6);
  await w.later();
  assert.ok(Math.max(...sizes) <= 400); assert.equal(sizes.reduce((a, b) => a + b, 0), 1400);
  assert.equal(w.reg.flywheel.revenueRaw, '9000000');
});

test('a reverted buy gives the money back to the next', async () => {
  const w = world();
  await w.run(); w.pay(SINK, 100e6);
  w.send = async () => { throw new Error('reverted'); };
  await assert.rejects(w.later());
  assert.equal(w.reg.flywheel.owedRaw, '70000000'); assert.equal(w.reg.flywheel.buying, null);
});

test('a failed buy is tried again at the next tick, a few times, then at the usual pace', async () => {
  const w = world();
  await w.run(); w.pay(SINK, 100e6);
  const ok = w.send;
  w.send = async () => { throw new Error('reverted'); };
  await assert.rejects(w.later());
  // seconds later, not minutes: a new quote and a new try
  for (let i = 0; i < 3; i++) await assert.rejects(w.later(0.25));
  assert.equal(w.reg.flywheel.failStreak, 4);
  await w.later(0.25); assert.equal(w.reg.flywheel.failStreak, 4, 'past the streak it waits the interval');
  w.send = ok;
  await w.later(5); assert.equal(w.sends.length, 2, 'bought and burned');
  assert.equal(w.reg.flywheel.failStreak, 0); assert.equal(w.reg.flywheel.owedRaw, '0');
  w.send = async () => { throw new Error('reverted'); };
  w.pay(SINK, 100e6); await assert.rejects(w.later(5));
  w.send = ok; await w.later(0.25); assert.equal(w.sends.length, 4, 'the next failure starts a new streak');
  assert.equal(publicFlywheel(w.reg.flywheel).failStreak, undefined);
});

test('payers: never a retired token, whose sweep is its own money', () => {
  const c = { token: TOKEN, pair: config.USDG, sink: SINK, subWallet: SUB };
  assert.equal(payers([c]).length, 2);
  config.RETIRED.add(TOKEN); assert.deepEqual(payers([c]), []); config.RETIRED.delete(TOKEN);
});

test('a retired platform token is still bought and burned: its pool is there', async () => {
  const w = world();
  config.FLYWHEEL_TOKEN = TOKEN; config.RETIRED.add(TOKEN.toLowerCase());
  try { await w.run(); assert.ok(w.reg.flywheel && w.reg.flywheel.token, w.log.join(' | ')); assert.ok(!w.log.some((l) => /off:/.test(l))); }
  finally { config.RETIRED.delete(TOKEN.toLowerCase()); }
});
