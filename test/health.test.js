const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const lighter = require('../lighter/client');
const { createHealth, LIMITS } = require('../lib/health');
const { handler } = require('../lib/publicServer');
const { publicSnapshot, writeHealth } = require('../lib/publish');
const { settleWithdrawal, settleDoubts, tickCoin } = require('../keeper');

const T = '0x' + 'ab'.repeat(20);
const coin = { token: T, symbol: 'T' };
const reg = (st) => ({ coins: [coin], state: { [T]: { lastTickTs: 0, ...st } } });

test('health: a condition is a problem only when it lasts, and forgotten when it ends', () => {
  let now = 1_000_000;
  const h = createHealth({ now: () => now });
  const at = (st) => h.check({ reg: reg({ lastTickTs: now, ...st }) }).problems.map((p) => p.what);
  assert.deepEqual(at({ perpWithdrawPendingUsd: 7 }), []);
  now += LIMITS.withdrawal - 1; assert.deepEqual(at({ perpWithdrawPendingUsd: 7 }), []);
  now += 1; assert.match(at({ perpWithdrawPendingUsd: 7 })[0], /withdrawal/);
  assert.deepEqual(at({}), [], 'arrived');
  now += LIMITS.withdrawal; assert.deepEqual(at({ perpWithdrawPendingUsd: 7 }), [], 'a new one starts its own clock');
  assert.deepEqual(at({ perpOrder: { id: 1 } }), [], 'just sent'); now += LIMITS.order; assert.match(at({ perpOrder: { id: 1 } })[0], /order/);
  now += LIMITS.transfer; assert.equal(at({ txOut: { label: 'x' } }).length, 0); now += LIMITS.transfer; assert.match(at({ txOut: { label: 'x' } })[0], /transfer/);
  assert.match(at({ perpDoubtUsd: 3 })[0], /without an answer/);
  assert.deepEqual(at({ engineBlocked: 'leverage above the market' }), [], 'shown on the site, not an alarm');
  assert.match(h.check({ reg: reg({ lastTickTs: now - LIMITS.stale }) }).problems[0].what, /not looked at/);
  config.PAUSED.add(T); assert.deepEqual(h.check({ reg: reg({ perpDoubtUsd: 3 }) }).problems, [], 'a paused token is nobody\'s worry'); config.PAUSED.delete(T);
  assert.match(h.check({ reg: { coins: [], state: {} }, gasEth: 0.001 }).problems[0].what, /ETH/);
  assert.deepEqual(h.check({ reg: { coins: [], state: {} }, gasEth: 0.01 }).problems, []);
  assert.deepEqual(h.check({ reg: { coins: [], state: {} }, feedWanted: true, feedLive: false }).problems, []);
  now += LIMITS.feed; assert.match(h.check({ reg: { coins: [], state: {} }, feedWanted: true, feedLive: false }).problems[0].what, /live prices/);
  assert.deepEqual(h.check({ reg: { coins: [], state: {} }, feedWanted: false, feedLive: false }).problems, [], 'nothing to listen to');
});

test('/alerts: 200 when all is well, 503 with what is wrong, and when no round has run for a while', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
  const file = path.join(dir, 'public.json'), healthFile = path.join(dir, 'health.json');
  const call = () => {
    const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b || ''; } };
    handler({ method: 'GET', url: '/alerts' }, res, file, healthFile);
    return [res.status, JSON.parse(res.body)];
  };
  assert.equal(call()[0], 503, 'no snapshot');
  fs.writeFileSync(file, JSON.stringify({ coins: [], state: {} }));
  assert.deepEqual(call()[0], 200, 'no health written yet: nothing known to be wrong');
  writeHealth({ at: 1, problems: [] }, healthFile);
  assert.deepEqual(call()[0], 200);
  writeHealth({ at: 1, problems: [{ symbol: 'T', what: 'x' }] }, healthFile);
  assert.deepEqual(call()[1].problems, [{ symbol: 'T', what: 'x' }]);
  assert.equal(fs.readFileSync(file, 'utf8').includes('problems'), false, 'not in the public snapshot');
  writeHealth({ at: 1, problems: [] }, healthFile);
  const old = (Date.now() - 11 * 60_000) / 1000; fs.utimesSync(file, old, old);
  const [s, b] = call(); assert.equal(s, 503); assert.match(b.problems[0].what, /no round/);
  const res = { status: 0, writeHead(x) { this.status = x; }, end() {} };
  handler({ method: 'GET', url: '/health' }, res, file); assert.equal(res.status, 200, 'the platform\'s check does not fail a deploy for it');
});

test('the snapshot carries the last read of each account, never more than the whitelist', async () => {
  const real = require('../lighter/rest').account;
  require('../lighter/rest').account = async () => ({ collateral: '50', available_balance: '12', positions: [
    { market_id: 15, sign: 1, size: '1.5', avg_entry_price: '100', allocated_margin: '7.5', liquidation_price: '96', total_funding_paid_out: '-0.1' },
    { market_id: 1, sign: 1, size: '0', avg_entry_price: '0', allocated_margin: '0', liquidation_price: '0', total_funding_paid_out: null },
  ] });
  try {
    const before = Date.now();
    await lighter.account(77);
    const v = lighter.accountView(77);
    assert.ok(v.at >= before); assert.equal(v.collateral, '50'); assert.equal(v.available, '12');
    assert.deepEqual(v.positions, [{ marketId: 15, sign: 1, size: '1.5', entry: '100', margin: '7.5', liquidation: '96', funding: '-0.1' }]);
    assert.equal(lighter.accountView(78), null); assert.equal(lighter.accountView(null), null);
    const snap = publicSnapshot({ coins: [], state: { a: { lighterAccountIndex: 77, lighterApiPrivKey: 'secret' }, b: { lighterAccountIndex: 5 } } }, { viewOf: lighter.accountView });
    assert.deepEqual(snap.state.a.perpView, v); assert.equal(snap.state.b.perpView, undefined); assert.equal(snap.state.a.lighterApiPrivKey, undefined);
    assert.equal(snap.health, undefined);
  } finally { require('../lighter/rest').account = real; }
});

test('a withdrawal booked in doubt is asked about again, and settled by the answer', async () => {
  const doubtful = () => ({
    perpRealizedUsd: 1, perpCapitalUsd: 2, perpWithdrawPendingUsd: 30, perpWithdrawPendingProfitUsd: 6, perpDoubtUsd: 30, perpWithdrawBlock: 9,
    perpDoubt: [{ tx: 'h', usd: 30, profitUsd: 6, askAt: 0 }],
  });
  const run = async (answer, st = doubtful()) => {
    lighter.tx = async () => { if (answer instanceof Error) throw answer; return answer; };
    await settleDoubts({ coin, st, checkpoint: () => {}, accountIndex: 1 });
    return st;
  };
  let st = await run({ status: 3 });
  assert.deepEqual([st.perpDoubtUsd, st.perpDoubt, st.perpWithdrawPendingUsd, st.perpCapitalUsd], [0, null, 30, 2], 'it left: its arrival is waited for');
  st = await run({ status: 0 });
  assert.deepEqual([st.perpDoubtUsd, st.perpDoubt, st.perpWithdrawPendingUsd, st.perpWithdrawPendingProfitUsd, st.perpRealizedUsd, st.perpCapitalUsd, st.perpWithdrawBlock], [0, null, 0, 0, 7, 26, null], 'it never left: back where it came from');
  for (const a of [null, { status: 1 }, new Error('500')]) {
    st = await run(a);
    assert.equal(st.perpDoubtUsd, 30); assert.equal(st.perpDoubt.length, 1); assert.ok(st.perpDoubt[0].askAt > Date.now(), 'asked again later');
  }
  let asked = 0; lighter.tx = async () => { asked++; return { status: 3 }; };
  await settleDoubts({ coin, st, checkpoint: () => {}, accountIndex: 1 }); assert.equal(asked, 0, 'not before its time');
});

test('health: dated by the state where it can be, so restarts do not hide what lasts', () => {
  const now = 1_800_000_000_000;
  const fresh = createHealth({ now: () => now }); // a keeper that has just started
  const st = { lastTickTs: now, perpOrder: { id: 1, at: now - LIMITS.order }, txOut: { label: 'x', at: now - LIMITS.transfer }, perpWithdrawPendingUsd: 5, perpWithdrawAt: now - LIMITS.withdrawal };
  assert.equal(fresh.check({ reg: reg(st) }).problems.length, 3);
});

test('a doubt is not asked about while another withdrawal is in flight (audit: its undo would erase the give-back)', async () => {
  const st = {
    perpRealizedUsd: 0, perpCapitalUsd: 0,
    perpDoubtUsd: 30, perpDoubt: [{ tx: 'D', usd: 30, profitUsd: 6, askAt: 0 }],
    perpWithdrawPendingUsd: 30, perpWithdrawPendingProfitUsd: 6, perpWithdrawBlock: 100, perpWithdrawScanBlock: 150,
    perpWithdrawIntentUsd: 10, perpWithdrawIntentProfitUsd: 0, perpWithdrawCashUsd: 40, perpWithdrawAt: Date.now() - 60_000,
    perpWithdrawWas: { realized: 0, capital: 10 }, perpWithdrawSent: true, perpWithdrawTx: 'W',
  };
  lighter.account = async () => ({ collateral: '40', available_balance: '40', positions: [] });
  lighter.tx = async () => ({ status: 0 });
  await settleWithdrawal({ coin, st, checkpoint: () => {}, accountIndex: 1 });
  // the intent failed and was undone; the doubt waits, the window is open
  assert.equal(st.perpWithdrawIntentUsd, 0); assert.equal(st.perpCapitalUsd, 10);
  assert.equal(st.perpDoubtUsd, 30); assert.equal(st.perpDoubt.length, 1); assert.equal(st.perpWithdrawBlock, 100);
  // next round, nothing in flight: the doubt is answered, and everything is back out of the engine
  await settleWithdrawal({ coin, st, checkpoint: () => {}, accountIndex: 1 });
  assert.equal(st.perpDoubtUsd, 0); assert.equal(st.perpWithdrawPendingUsd, 0); assert.equal(st.perpWithdrawPendingProfitUsd, 0);
  assert.equal(st.perpRealizedUsd + st.perpCapitalUsd, 40, 'all $40 on Lighter is booked out of the engine');
});

test('a doubt given back never leaves a profit share behind (audit)', async () => {
  const st = { perpRealizedUsd: 0, perpCapitalUsd: 0, perpDoubtUsd: 30, perpDoubt: [{ tx: 'D', usd: 30, profitUsd: 0, askAt: 0 }], perpWithdrawPendingUsd: 30, perpWithdrawPendingProfitUsd: 12, perpWithdrawBlock: 100 };
  lighter.tx = async () => ({ status: 0 });
  await settleDoubts({ coin, st, checkpoint: () => {}, accountIndex: 1 });
  assert.equal(st.perpWithdrawPendingUsd, 0); assert.equal(st.perpWithdrawPendingProfitUsd, 0);
  const two = { perpRealizedUsd: 0, perpCapitalUsd: 0, perpDoubtUsd: 10, perpDoubt: [{ tx: 'D', usd: 10, profitUsd: 0, askAt: 0 }], perpWithdrawPendingUsd: 30, perpWithdrawPendingProfitUsd: 25, perpWithdrawBlock: 100 };
  await settleDoubts({ coin, st: two, checkpoint: () => {}, accountIndex: 1 });
  assert.equal(two.perpWithdrawPendingUsd, 20); assert.ok(two.perpWithdrawPendingProfitUsd <= 20);
});

test('a doubt given back keeps the treasury share of what is still on its way (audit)', async () => {
  const { ethers } = require('ethers');
  const { splitArrival } = require('../keeper');
  // D ($30, all capital) and W2 ($20, all profit) pending together; W2 arrives first, then D failed
  const first = splitArrival(ethers.BigNumber.from(20_000_000), 50, 20);
  const st = { perpRealizedUsd: 0, perpCapitalUsd: 0, perpDoubtUsd: 30, perpDoubt: [{ tx: 'D', usd: 30, profitUsd: 0, askAt: 0 }], perpWithdrawPendingUsd: 30, perpWithdrawPendingProfitUsd: 12, perpWithdrawBlock: 100 };
  lighter.tx = async () => ({ status: 0 });
  await settleDoubts({ coin, st, checkpoint: () => {}, accountIndex: 1 });
  assert.equal(st.perpWithdrawPendingUsd, 0);
  // what was still owed as profit came back as profit: the next withdrawal pays it
  const treasuryLater = st.perpRealizedUsd * 0.3;
  assert.ok(Math.abs(first.toTreasury.toNumber() / 1e6 + treasuryLater - 6) < 1e-6, String(first.toTreasury.toNumber() / 1e6 + treasuryLater));
  assert.equal(st.perpRealizedUsd + st.perpCapitalUsd, 30);
});

test('the doubt is written down with what it needs to be asked about again', async () => {
  const st = { perpRealizedUsd: 0, perpCapitalUsd: 0, perpWithdrawIntentUsd: 30, perpWithdrawIntentProfitUsd: 6, perpWithdrawPendingUsd: 0, perpWithdrawCashUsd: 30.5, perpWithdrawAt: Date.now() - 11 * 60_000, perpWithdrawWas: { realized: 6, capital: 24 }, perpWithdrawSent: true, perpWithdrawTx: 'hh', perpWithdrawUnread: Date.now() - config.TX_UNREAD_MS };
  lighter.account = async () => ({ collateral: '30.5', positions: [] });
  lighter.tx = async () => { throw new Error('500'); };
  assert.equal(await settleWithdrawal({ coin, st, checkpoint: () => {}, accountIndex: 1 }), true);
  assert.equal(st.perpDoubtUsd, 30); assert.equal(st.perpWithdrawPendingUsd, 30);
  assert.equal(st.perpDoubt.length, 1); assert.equal(st.perpDoubt[0].tx, 'hh'); assert.equal(st.perpDoubt[0].usd, 30); assert.equal(st.perpDoubt[0].profitUsd, 6);
});
