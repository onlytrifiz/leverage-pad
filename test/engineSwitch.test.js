const test = require('node:test');
const assert = require('node:assert/strict');
const lighter = require('../lighter/client');
const config = require('../config');
const { strayPositions, settleEngineSwitch, closeProceeds, withdrawalOf, splitArrival, settleOrder, depositDue, minDeploy, perpTick, tickCoin } = require('../keeper');
const { encryptSecret } = require('../lib/secrets');

Object.assign(config, { LIGHTER_FILL_RETRY_MS: 0, LIGHTER_ORDER_SETTLE_MS: 0, MASTER_SECRET: 'test-secret', PERP_WITHDRAW_FLOOR_USD: 25, OPEN_GATE_USD: 25, TOPUP_STEP_USD: 25, TRANCHE_INTERVAL_MS: 3_600_000 });

/**
 * A managed coin whose creator moved the engine to another market or side.
 *
 * The venue is a small simulation: one account, isolated positions, market orders that fill at
 * the mark less a slippage, or refuse, or do not fill. What is checked is what costs money when
 * wrong: nothing opens over the old position, and only real profit is ever banked.
 */
const MARKETS = {
  NVDA: { index: 15, size_dec: 4, price_dec: 2, min_base: '0.04', min_quote: '10', status: 'active' },
  ANT: { index: 4108, size_dec: 4, price_dec: 2, min_base: '0.1', min_quote: '10', status: 'active' },
};

function venue({ positions, cash = 0, slip = 0, refuse = () => false, fill = (n) => n, seen = true }) {
  const v = { positions: positions.map((p) => ({ ...p })), cash, closes: [], reads: 0, trades: {} };
  lighter.fills = async ({ clientOrderIndex }) => {
    if (!seen) throw new Error('503');
    return v.trades[clientOrderIndex] ?? { size: 0, price: null };
  };
  const pnl = (p) => p.sign * p.units * (p.mark - p.entry);
  const view = () => ({
    positions: v.positions.map((p) => ({ market_id: p.id, sign: p.sign, size: String(p.units), avg_entry_price: String(p.entry), unrealized_pnl: String(pnl(p)), total_funding_paid_out: p.funding ?? 0 })),
    raw: { total_asset_value: String(v.cash + v.positions.reduce((a, p) => a + p.margin + pnl(p), 0)) },
  });
  lighter.account = async () => { v.reads++; return view(); };
  lighter.marketById = async (id) => {
    const e = Object.entries(MARKETS).find(([, m]) => m.index === Number(id));
    return e ? { symbol: e[0], ...lighter.parseMarket(e[0], e[1]) } : null;
  };
  lighter.close = async (o) => {
    v.closes.push(o);
    if (refuse(o, v)) { const e = new Error('lighter:close: excessive slippage'); e.definitive = true; throw e; }
    const p = v.positions.find((x) => x.id === Number(o.marketIndex));
    assert.equal(o.isAsk, p.sign === 1, 'reduce-only: a long is sold, a short is bought');
    const units = fill(Math.min(p.units, o.baseAmount / 1e4));
    const px = p.mark * (1 - p.sign * slip);
    const part = p.units ? units / p.units : 0;
    assert.ok(!v.trades[o.clientOrderIndex], 'every order has its own index');
    v.trades[o.clientOrderIndex] = { size: units, price: px };
    v.cash += p.margin * part + p.sign * units * (px - p.entry);
    p.margin *= 1 - part; p.units = Math.round((p.units - units) * 1e4) / 1e4;
  };
  return v;
}
const tranche = (base, entryMark, ts = 1) => ({ base, entryMark, collateralUsd: 0, sizeDec: 4, ts, leverage: 10 });
const setup = (over = {}) => ({
  coin: { symbol: 'MGD', managed: true, market: 'NVDA', side: 'short', ...over.coin },
  st: { perpEngine: { market: 'NVDA', side: 'long' }, perpSwitch: null, perpTranches: [tranche(10_0000, 100)], perpOpen: true, perpRealizedUsd: 0, perpFundingSeen: {}, ...over.st },
  checkpoint: () => {}, accountIndex: 1, marketIndex: 15, apiPrivKey: 'k', apiKeyIndex: 4, sim: false, tag: '', ...over.ctx,
});
const log = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = log; });

test('strayPositions: another market or the other side, never an empty slot or the engine\'s own', () => {
  const ps = [{ market_id: 15, sign: 1, size: '2' }, { market_id: 4108, sign: 1, size: '3' }, { market_id: 7, sign: 1, size: '0.0000' }];
  assert.deepEqual(strayPositions(ps, 15, 'long').map((p) => p.market_id), [4108]);
  assert.deepEqual(strayPositions(ps, 15, 'short').map((p) => p.market_id), [15, 4108]);
  assert.deepEqual(strayPositions(ps, null, 'long').map((p) => p.market_id), [15, 4108], 'a market the venue does not list owns nothing');
  assert.deepEqual(strayPositions(undefined, 15, 'long'), []);
});

test('side flip in profit: closed whole, profit net of slippage banked, the next tick is free to trade', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }], slip: 0.01 });
  const c = setup();
  assert.equal(await settleEngineSwitch(c), true, 'this tick stops here');
  assert.equal(v.closes.length, 1);
  assert.equal(v.closes[0].baseAmount, 10_0000);
  assert.equal(v.positions[0].units, 0);
  // 10 x $20 = $200 on paper, 1% of $1,200 lost to the book
  assert.ok(Math.abs(c.st.perpRealizedUsd - 188) < 1e-6, String(c.st.perpRealizedUsd));
  assert.deepEqual(c.st.perpTranches, []);
  assert.equal(c.st.perpOpen, false);
  assert.equal(await settleEngineSwitch(c), false, 'nothing of the old engine is left');
  assert.deepEqual(c.st.perpEngine, { market: 'NVDA', side: 'short' });
  assert.equal(c.st.perpSwitch, null);
  const reads = v.reads;
  assert.equal(await settleEngineSwitch(c), false);
  assert.equal(v.reads, reads, 'a settled coin costs no extra read');
});

test('in loss: closed the same, nothing banked, profit already realized untouched', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 95, margin: 100 }] });
  const c = setup({ st: { perpRealizedUsd: 7 } });
  await settleEngineSwitch(c);
  assert.equal(c.st.perpRealizedUsd, 7);
  assert.equal(v.positions[0].units, 0);
});

test('mixed tranches are netted: a losing one eats the winning one', async () => {
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 115, mark: 120, margin: 100 }] });
  const c = setup({ st: { perpTranches: [tranche(5_0000, 100, 1), tranche(5_0000, 130, 2)] } });
  await settleEngineSwitch(c);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 50) < 1e-6, String(c.st.perpRealizedUsd)); // +100 and -50
});

test('market change: the old market is closed, the new one is left alone', async () => {
  const v = venue({ positions: [{ id: 15, sign: -1, units: 10, entry: 100, mark: 90, margin: 100 }] });
  const c = setup({ coin: { market: 'ANT', side: 'short' }, ctx: { marketIndex: 4108 }, st: { perpEngine: { market: 'NVDA', side: 'short' } } });
  assert.equal(await settleEngineSwitch(c), true);
  assert.equal(v.closes[0].isAsk, false, 'a short is bought back');
  assert.ok(Math.abs(c.st.perpRealizedUsd - 100) < 1e-6);
  assert.equal(await settleEngineSwitch(c), false);
  assert.deepEqual(c.st.perpEngine, { market: 'ANT', side: 'short' });
});

test('empty book: nothing is banked, nothing opens, every tick tries again until it fills', async () => {
  let open = false;
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }], fill: (n) => (open ? n : 0) });
  const c = setup();
  for (let i = 0; i < 3; i++) assert.equal(await settleEngineSwitch(c), true);
  assert.equal(v.closes.length, 3);
  assert.equal(c.st.perpRealizedUsd, 0);
  assert.equal(c.st.perpTranches.length, 1);
  open = true;
  assert.equal(await settleEngineSwitch(c), true);
  assert.equal(c.st.perpRealizedUsd, 200);
  assert.equal(await settleEngineSwitch(c), false);
});

test('partial fills: one net result, banked once, when the position is closed', async () => {
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }], fill: (n) => Math.min(n, 4) });
  const c = setup();
  await settleEngineSwitch(c);
  assert.equal(c.st.perpRealizedUsd, 0, 'not yet');
  assert.ok(Math.abs(c.st.perpSwitch.pnl - 80) < 1e-6);
  assert.equal(c.st.perpTranches[0].base, 6_0000);
  assert.equal(c.st.perpOpen, true);
  await settleEngineSwitch(c); await settleEngineSwitch(c);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 200) < 1e-6, 'the total, once');
  assert.equal(await settleEngineSwitch(c), false);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 200) < 1e-6);
});

test('partial fills do not undo the netting: winners first, losers forgotten', async () => {
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 115, mark: 120, margin: 100 }], fill: (n) => Math.min(n, 5) });
  const c = setup({ st: { perpTranches: [tranche(5_0000, 100, 1), tranche(5_0000, 130, 2)] } });
  await settleEngineSwitch(c); await settleEngineSwitch(c);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 50) < 1e-6, String(c.st.perpRealizedUsd));
});

test('opening slippage is not profit: filled above the mark, the thin gain is not there', async () => {
  // sized at 100, filled at 101, price +0.8%: the book says +8, the account lost
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 101, mark: 100.8, margin: 100 }] });
  const c = setup();
  await settleEngineSwitch(c);
  assert.equal(c.st.perpRealizedUsd, 0);
});

test('flipping back and forth at a flat price never makes profit out of slippage', async () => {
  let realized = 0;
  for (let i = 0; i < 20; i++) {
    const sign = i % 2 ? -1 : 1, side = sign === 1 ? 'long' : 'short', other = sign === 1 ? 'short' : 'long';
    venue({ positions: [{ id: 15, sign, units: 10, entry: 100 + sign, mark: 100 + sign * 0.5, margin: 100 }], slip: 0.01 });
    const c = setup({ coin: { side: other }, st: { perpEngine: { market: 'NVDA', side } } });
    while (await settleEngineSwitch(c));
    realized += c.st.perpRealizedUsd;
  }
  assert.equal(realized, 0);
});

test('taken back half way: what was closed is settled, the rest stays', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }], fill: (n) => Math.min(n, 4) });
  const c = setup();
  await settleEngineSwitch(c);
  c.coin.side = 'long';
  assert.equal(await settleEngineSwitch(c), false);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 80) < 1e-6);
  assert.equal(c.st.perpTranches[0].base, 6_0000);
  assert.equal(v.positions[0].units, 6);
});

test('an empty book is a refusal too, and a healthy one afterwards closes the rest quickly', async () => {
  let dead = true;
  const v = venue({ positions: [{ id: 15, sign: 1, units: 2, entry: 100, mark: 100, margin: 20 }], refuse: () => dead, fill: (n) => (n * 100 < 10 ? 0 : n) });
  const c = setup({ st: { perpTranches: [tranche(2_0000, 100)] } });
  for (let i = 0; i < 100; i++) assert.equal(await settleEngineSwitch(c), true);
  dead = false;
  let n = 0;
  while (await settleEngineSwitch(c)) assert.ok(++n < 12, 'it ends');
  assert.equal(v.positions[0].units, 0);
  assert.ok(v.closes.every((o) => o.baseAmount >= 1000), 'never an order under the venue minimum');
});

test('a book too thin for the whole size: smaller attempts until it is all closed', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }], refuse: (o) => o.baseAmount > 3_0000 });
  const c = setup();
  let n = 0;
  while (await settleEngineSwitch(c)) assert.ok(++n < 40, 'it ends');
  assert.equal(v.positions[0].units, 0);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 200) < 1e-6);
});

test('an ambiguous failure stops the tick and banks nothing', async () => {
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  lighter.close = async () => { throw new Error('timeout'); };
  const c = setup();
  await assert.rejects(settleEngineSwitch(c), /timeout/);
  assert.equal(c.st.perpRealizedUsd, 0);
  assert.equal(c.st.perpTranches.length, 1);
});

test('closed but the read after it failed: read again, booked all the same', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  const read = lighter.account;
  let n = 0;
  lighter.account = async () => { if (++n === 3) throw new Error('503'); return read(); };
  const c = setup();
  assert.equal(await settleEngineSwitch(c), true);
  assert.equal(v.positions[0].units, 0);
  assert.equal(c.st.perpRealizedUsd, 200);
  assert.deepEqual(c.st.perpTranches, []);
  assert.equal(await settleEngineSwitch(c), false);
});

test('changed and changed back before it was carried out: the position is kept', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  const c = setup({ coin: { side: 'long' }, st: { perpSwitch: { from: { market: 'NVDA', side: 'long' }, to: { market: 'NVDA', side: 'short' }, since: 1 } } });
  assert.equal(await settleEngineSwitch(c), false);
  assert.equal(v.closes.length, 0);
  assert.equal(c.st.perpTranches.length, 1);
  assert.equal(c.st.perpSwitch, null);
});

test('a leftover below the venue minimum does not block the switch, and is closed if it grows', async () => {
  for (const how of [{ refuse: () => true }, { fill: () => 0 }]) {
    const v = venue({ positions: [{ id: 15, sign: 1, units: 0.05, entry: 100, mark: 100, margin: 0 }], ...how }); // $5: over min_base, under $10
    const c = setup({ coin: { market: 'ANT', side: 'long' }, ctx: { marketIndex: 4108 }, st: { perpTranches: [] } });
    for (let i = 0; i < 3; i++) assert.equal(await settleEngineSwitch(c), true);
    assert.equal(await settleEngineSwitch(c), false, 'left alone');
    v.positions[0].units = 2;
    c.st.perpEngine = { market: 'NVDA', side: 'long' };
    assert.equal(await settleEngineSwitch(c), true, 'no longer dust');
  }
});

test('an engine pointed at a market the venue does not list: the old position still closes', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  const c = setup({ coin: { market: 'NOPE', side: 'long' }, ctx: { marketIndex: null } });
  assert.equal(await settleEngineSwitch(c), true);
  assert.equal(v.positions[0].units, 0);
});

test('funding charged since the last read is settled before the position disappears', async () => {
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 100, margin: 100, funding: -3 }] });
  const c = setup({ st: { perpFundingSeen: { 15: 0 } } });
  await settleEngineSwitch(c);
  assert.equal(c.st.perpFundingUsd, -3);
  assert.equal(c.st.perpRealizedUsd, 0, 'the venue takes it from the margin: it comes off what the close pays');
});

test('simulate: reads only', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  assert.equal(await settleEngineSwitch(setup({ ctx: { sim: true } })), true);
  assert.equal(v.closes.length, 0);
});

test('what banks is the price it filled at', async () => {
  // a 50x long, $3.78 in profit on $378
  venue({ positions: [{ id: 15, sign: 1, units: 3.78, entry: 100, mark: 101, margin: 7.56 }], slip: 0.0005 });
  const c = setup({ st: { perpTranches: [tranche(3_7800, 100)] } });
  await settleEngineSwitch(c);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 3.78 * (101 * 0.9995 - 100)) < 1e-9, String(c.st.perpRealizedUsd));
});

test('trades not readable: nothing moves until they are, then it is booked as it filled', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }], slip: 0.01, seen: false });
  const c = setup();
  for (let i = 0; i < 3; i++) assert.equal(await settleEngineSwitch(c), true);
  assert.equal(v.closes.length, 1);
  assert.equal(c.st.perpRealizedUsd, 0);
  assert.equal(c.st.perpTranches.length, 1);
  lighter.fills = async ({ clientOrderIndex }) => v.trades[clientOrderIndex];
  await settleEngineSwitch(c);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 188) < 1e-6, String(c.st.perpRealizedUsd));
});

test('closeProceeds: the margin and the result, as the venue paid them on 25 Nov 2026', () => {
  const near = (a, b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
  // take-profit of the whole short: $2.91 was booked at the mark, $2.056892 paid
  const avgEntry = (343.345885 + 122.622181) / 0.00794;
  const whole = closeProceeds({ filled: 794, base: 794, price: 58427.1, avgEntry, margin: 9.325318, side: 'short', sizeDec: 5 });
  near(whole.profit, 2.056892); near(whole.capital, 9.325318);
  // the switch of the long: -$1.37, logged as -$8.97
  near(closeProceeds({ filled: 644, base: 644, price: (293.3185 + 84.47184) / 0.00644, avgEntry: 58876.063, margin: 7.58, side: 'long', sizeDec: 5 }).pnl, -1.3716, 1e-3);
  const half = closeProceeds({ filled: 5, base: 10, price: 90, avgEntry: 100, margin: 100, side: 'long', sizeDec: 0 });
  assert.deepEqual([half.profit, half.capital], [0, 0], 'a loss past the margin gives nothing back');
});

test('settleOrder: partial, late, stale and unknown', async () => {
  const run = async (o, { size = 0, price = 100, here = 10, age = 0, settle = 20_000, cash = 205 } = {}) => {
    config.LIGHTER_ORDER_SETTLE_MS = settle;
    lighter.fills = async () => { if (size == null) throw new Error('gone'); return { size, price: size ? price : null }; };
    lighter.account = async () => ({ collateral: String(cash), positions: here ? [{ market_id: 1, sign: 1, size: String(here) }] : [] });
    const st = { perpOpen: true, perpRealizedUsd: 0, perpCapitalUsd: 0, perpTranches: [tranche(10, 100)], perpOrder: { id: 1, kind: 'tp', marketIndex: 1, side: 'long', sizeDec: 0, base: 10, ask: 10, avgEntry: 90, margin: 100, mark: 101, cash: 5, ready: [tranche(10, 100)], keep: [], at: Date.now() - age, sentAt: Date.now() - age, sent: true, ...o } };
    const done = await settleOrder({ coin: { symbol: 'T' }, st, checkpoint: () => {}, accountIndex: 1 });
    config.LIGHTER_ORDER_SETTLE_MS = 0;
    return [done, st.perpTranches.reduce((a, t) => a + t.base, 0), st.perpCapitalUsd, st.perpRealizedUsd];
  };
  assert.deepEqual(await run({}, { size: 10, here: 0 }), [true, 0, 100, 100], 'whole: at once');
  assert.deepEqual(await run({}, { size: 10, here: 10 }), [true, 0, 100, 100], 'whole, the position read is stale');
  assert.deepEqual(await run({}, { size: 4, here: 6 }), [false, 10, 0, 0], 'more trades may follow');
  assert.deepEqual(await run({}, { size: 4, here: 6, age: 30_000 }), [true, 6, 40, 40], 'partial');
  assert.deepEqual(await run({}, { size: 0, here: 0, age: 30_000 }), [false, 10, 0, 0], 'closed, trades not there yet');
  assert.deepEqual(await run({}, { size: 0, here: 10 }), [false, 10, 0, 0], 'not yet');
  assert.deepEqual(await run({}, { size: 0, here: 10, age: 30_000 }), [true, 10, 0, 0], 'not filled');
  assert.deepEqual(await run({ sent: false }, { size: 0, here: 10, age: 30_000 }), [false, 10, 0, 0], 'it may still land');
  assert.deepEqual(await run({ sent: false }, { size: 10, here: 0, age: 30_000 }), [true, 0, 100, 100], 'it had landed');
  assert.deepEqual(await run({ sentAt: Date.now() - 2_000 }, { size: 0, here: 10, age: 30_000 }), [false, 10, 0, 0], 'counted from the answer, not from the record');
  assert.deepEqual(await run({}, { size: 0, here: 0, age: 11 * 60_000 }), [false, 10, 0, 0], 'the position says it closed');
  assert.deepEqual(await run({}, { size: null, here: 0, age: 11 * 60_000 }), [false, 10, 0, 0], 'unreadable');
  assert.deepEqual(await run({}, { size: null, here: 0, age: 21 * 60_000 }), [true, 0, 100, 100], 'for good: the cash says it');
  assert.deepEqual(await run({}, { size: null, here: 0, age: 21 * 60_000, cash: 999 }), [true, 0, 100, 110], 'a deposit is not a gain: never past the mark');
  assert.deepEqual(await run({}, { size: null, here: 0, age: 21 * 60_000, cash: 5 }), [true, 0, 0, 0], 'liquidated');
  assert.deepEqual(await run({ sent: false }, { size: 0, here: 10, age: 11 * 60_000 }), [true, 10, 0, 0], 'expired');
});

/** a venue for perpTick: cash, one isolated netted position, margin released pro rata */
function engine({ cash = 0, px = 100, coin: over = {}, st: more = {} } = {}) {
  const v = { cash, units: 0, avg: 0, margin: 0, px, trades: {}, opens: [], closes: [], pulls: [] };
  const coin = { symbol: 'T', pair: config.USDG, pairDecimals: 6, venue: 'v4', market: 'BTC', side: 'long', leverage: 10, takeProfitPct: 100, ...over };
  const st = { perpReserveRaw: '0', lighterAccountIndex: 1, lighterApiPrivKey: encryptSecret('k'), lighterApiKeyIndex: 4, lighterLeverage: coin.leverage, perpTranches: [], perpRealizedUsd: 0, perpCapitalUsd: 0, perpFundingUsd: 0, perpFundingSeen: {}, perpOpen: false, perpDepositedUsd: 25, perpWithdrawPendingUsd: 0, perpWithdrawIntentUsd: 0, perpWithdrawBlock: 7, ...more };
  const up = () => v.units * (v.px - v.avg);
  lighter.market = async () => ({ index: 1, sizeDec: 4, minBaseUnits: 1, minQuoteUsd: 10, maxLeverage: 50 });
  lighter.account = async () => ({ collateral: String(v.cash), available_balance: String(v.cash + Math.max(0, up())), positions: v.units ? [{ market_id: 1, sign: 1, size: v.units.toFixed(4), avg_entry_price: String(v.avg), unrealized_pnl: String(up()), allocated_margin: String(v.margin), total_funding_paid_out: '0.2' }] : [] });
  lighter.fills = async ({ clientOrderIndex }) => v.trades[clientOrderIndex] ?? { size: 0, price: null };
  lighter.open = async (o) => {
    const u = Math.floor(o.notionalUsd / v.px * 1e4) / 1e4, at = v.px * 1.001, m = u * at / coin.leverage;
    v.avg = (v.avg * v.units + at * u) / (v.units + u); v.units += u; v.margin += m; v.cash -= m;
    v.trades[o.clientOrderIndex] = { size: u, price: at }; v.opens.push(o.notionalUsd);
    return { baseAmount: Math.round(u * 1e4), mark: v.px };
  };
  lighter.close = async (o) => {
    const u = Math.min(v.units, o.baseAmount / 1e4), at = v.px * 0.999, f = u / v.units;
    v.cash += v.margin * f + u * (at - v.avg); v.margin *= 1 - f; v.units = Math.round((v.units - u) * 1e4) / 1e4;
    v.trades[o.clientOrderIndex] = { size: u, price: at }; v.closes.push(u);
  };
  lighter.withdraw = async (o) => { v.cash -= o.amount; v.pulls.push(o.amount); };
  const ctx = { v, st, coin, disk: null };
  ctx.tick = () => perpTick(null, ctx.coin, ctx.st, () => { ctx.disk = JSON.parse(JSON.stringify(ctx.st)); }, {}, 1, null);
  /** the process dies and the next one reads what was on disk */
  ctx.reborn = () => { ctx.st = JSON.parse(JSON.stringify(ctx.disk)); };
  return ctx;
}
const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test('perpTick: opens at the price it paid; a take-profit takes everything out and none of it goes back in', async () => {
  const e = engine({ cash: 100 });
  await e.tick();
  close(e.st.perpTranches[0].entryMark, 100.1);
  const margin = e.v.margin, units = e.v.units, idle = e.v.cash;
  await e.tick();
  assert.equal(e.st.perpRealizedUsd, 0, 'a funding counter that was already there is nobody\'s profit');
  e.v.px = 108; // open profit the venue counts as free
  await e.tick();
  assert.equal(e.v.opens.length, 1, 'no top-up on unrealized profit');
  e.v.px = 111;
  await e.tick();
  close(e.st.perpCapitalUsd, margin); close(e.st.perpRealizedUsd, units * (111 * 0.999 - 100.1));
  close(e.v.cash, idle + e.st.perpCapitalUsd + e.st.perpRealizedUsd);
  assert.equal(e.st.perpOpen, false);
  config.PERP_WITHDRAW_FLOOR_USD = 1e9;
  for (let i = 0; i < 3; i++) await e.tick();
  assert.equal(e.v.opens.length, 1, 'nothing opens on the proceeds');
  e.v.cash += 30;
  await e.tick();
  close(e.v.opens[1], (idle + 30) * config.COLLATERAL_HEADROOM * 10);
  config.PERP_WITHDRAW_FLOOR_USD = 25;
});

test('a take-profit with two tranches books the cash the venue releases, no more', async () => {
  const e = engine({ cash: 1000 });
  e.v.px = 100; await e.tick(); e.v.cash += 1000; e.v.px = 104; e.st.perpTrancheAt = 0; await e.tick();
  assert.equal(e.st.perpTranches.length, 2);
  const cash = e.v.cash;
  e.v.px = 110.5; await e.tick();
  assert.equal(e.st.perpTranches.length, 1);
  close(e.st.perpCapitalUsd + e.st.perpRealizedUsd, e.v.cash - cash);
});

test('killed at any moment of a take-profit: the whole tranche is still booked, once', async () => {
  for (const when of ['after send', 'timeout, filled', 'timeout, not sent']) {
    const e = engine({ cash: 100 });
    await e.tick();
    const send = lighter.close, read = lighter.fills, margin = e.v.margin, units = e.v.units;
    e.v.px = 111;
    if (when === 'after send') lighter.fills = async () => { throw new Error('killed'); };
    else lighter.close = async (o) => { if (when === 'timeout, filled') await send(o); throw new Error('timeout'); };
    await e.tick().catch(() => {});
    e.reborn(); lighter.close = send; lighter.fills = read;
    if (when === 'timeout, not sent') {
      await e.tick();
      assert.equal(e.v.closes.length, 0, 'not again while it may still land');
      e.st.perpOrder.at -= 11 * 60_000;
      await e.tick();
    }
    config.PERP_WITHDRAW_FLOOR_USD = 1e9;
    for (let i = 0; i < 3; i++) await e.tick();
    config.PERP_WITHDRAW_FLOOR_USD = 25;
    close(e.st.perpCapitalUsd, margin); close(e.st.perpRealizedUsd, units * (111 * 0.999 - 100.1));
    assert.equal(e.v.closes.length, 1, when); assert.equal(e.v.opens.length, 1, when);
  }
});

test('killed after an opening: its tranche keeps the price it paid', async () => {
  const e = engine({ cash: 100 });
  const read = lighter.fills;
  lighter.fills = async () => { throw new Error('killed'); };
  await e.tick(); e.reborn(); lighter.fills = read; e.v.px = 105;
  await e.tick();
  assert.equal(e.st.perpTranches.length, 1); close(e.st.perpTranches[0].entryMark, 100.1);
  assert.equal(e.st.perpTranches[0].synthetic, undefined);
});

test('a refused take-profit tries smaller sizes and opens nothing; a refused opening does not stop the rest', async () => {
  const e = engine({ cash: 1000 });
  await e.tick();
  const send = lighter.close;
  lighter.close = async (o) => { if (o.baseAmount > 30_0000) { const x = new Error('excessive slippage'); x.definitive = true; throw x; } return send(o); };
  config.PERP_WITHDRAW_FLOOR_USD = 1e9;
  e.v.px = 111;
  for (let i = 0; i < 30 && e.st.perpOpen; i++) await e.tick();
  config.PERP_WITHDRAW_FLOOR_USD = 25;
  assert.equal(e.v.units, 0); assert.equal(e.v.opens.length, 1);
  const f = engine({ cash: 60, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  lighter.open = async () => { const x = new Error('excessive slippage'); x.definitive = true; throw x; };
  await f.tick(); assert.deepEqual(f.v.pulls, [30]);
  await f.tick(); await f.tick();
  assert.equal(f.st.perpOrder, null);
});

test('a withdrawal: whole, the gain apart, believed when its cash is gone', async () => {
  const e = engine({ cash: 30.5, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  await e.tick();
  assert.deepEqual(e.v.pulls, [30]); assert.equal(e.st.perpWithdrawPendingUsd, 0);
  await e.tick();
  assert.deepEqual([e.st.perpRealizedUsd, e.st.perpCapitalUsd, e.st.perpWithdrawPendingUsd, e.st.perpWithdrawPendingProfitUsd, e.st.perpWithdrawIntentUsd], [0, 0, 30, 6, 0]);
  assert.equal(e.v.pulls.length, 1);

  const refused = engine({ cash: 30.5, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  lighter.withdraw = async () => { const x = new Error('too small'); x.definitive = true; throw x; };
  await refused.tick();
  assert.deepEqual([refused.st.perpRealizedUsd, refused.st.perpCapitalUsd, refused.st.perpWithdrawIntentUsd, refused.st.perpWithdrawBlock], [6, 24, 0, null]);
  refused.v.cash += 100; await refused.tick();
  assert.equal(refused.v.opens.length, 1, 'a refusal holds nothing else');
});

test('a withdrawal whose end is unknown: sent, or never executed, and nothing is opened on it meanwhile', async () => {
  const sent = engine({ cash: 60, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  const send = lighter.withdraw;
  lighter.withdraw = async (o) => { await send(o); throw new Error('timeout'); };
  await sent.tick(); sent.reborn(); await sent.tick();
  assert.equal(sent.st.perpWithdrawPendingUsd, 30); assert.equal(sent.v.pulls.length, 1);

  const lost = engine({ cash: 60, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  lighter.withdraw = async () => { throw new Error('timeout'); };
  await lost.tick(); lost.reborn(); await lost.tick();
  assert.equal(lost.v.opens.length, 0);
  lost.st.perpWithdrawAt -= 11 * 60_000; lost.st.perpDepositAt = Date.now() - 20 * 60_000;
  lighter.withdraw = send;
  await lost.tick();
  assert.equal(lost.st.perpWithdrawPendingUsd, 0); assert.equal(lost.v.opens.length, 0);
  assert.deepEqual([lost.st.perpRealizedUsd, lost.st.perpCapitalUsd], [0, 0], 'given back and sent again');
  assert.equal(lost.st.perpWithdrawIntentUsd, 30);
});

test('a market that is not listed, or a switch that waits, does not hold the withdrawal', async () => {
  const e = engine({ cash: 30.5, coin: { managed: true, market: 'NOPE' }, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  lighter.market = async () => { const x = new Error('unknown'); x.unknownMarket = true; throw x; };
  await e.tick();
  assert.deepEqual(e.v.pulls, [30]);
});

test('flat and short of cash: written off after two ticks in a row, not after one and one later', async () => {
  const e = engine({ cash: 20, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  await e.tick(); assert.equal(e.st.perpCapitalUsd, 24);
  e.v.cash = 30; config.PERP_WITHDRAW_FLOOR_USD = 1e9; await e.tick();
  e.v.cash = 20; await e.tick(); assert.equal(e.st.perpCapitalUsd, 24, 'the latch was cleared');
  await e.tick(); close(e.st.perpCapitalUsd + e.st.perpRealizedUsd, 20);
  config.PERP_WITHDRAW_FLOOR_USD = 25;
});

test('funding owed by a position that was liquidated is not the next one\'s', async () => {
  const e = engine({ cash: 0, st: { perpOpen: true, perpRealizedUsd: -5, perpTranches: [tranche(10, 100)] } });
  await e.tick();
  assert.equal(e.st.perpRealizedUsd, 0); assert.deepEqual(e.st.perpTranches, []);
});

test('a managed switch carries the capital into the new engine, however little', async () => {
  const c = setup({ st: { perpSwitch: { from: { market: 'NVDA', side: 'long' }, to: { market: 'NVDA', side: 'short' }, since: 1 }, perpTranches: [], perpOpen: false } });
  venue({ positions: [] });
  assert.equal(await settleEngineSwitch(c), false);
  assert.equal(c.st.perpCarry, true);
  assert.equal(minDeploy(c.st), config.MIN_DEPLOY_USD);
  assert.ok(minDeploy({ perpOpen: false }) > 20, 'leftovers do not open a position of their own');
});

test('depositDue: ten minutes from the launch, then one tranche an hour, a closed position at once', () => {
  Object.assign(config, { OPEN_GATE_USD: 25, TOPUP_STEP_USD: 25, TRANCHE_INTERVAL_MS: 3_600_000, FIRST_OPEN_DELAY_MS: 600_000 });
  const now = 1_800_000_000_000, min = 60_000;
  const due = (usd, st, age = 1e9) => depositDue({ coin: { createdAt: new Date(now - age).toISOString() }, st: { perpDepositedUsd: 100, ...st }, usd, now });
  assert.equal(due(200, { perpDepositedUsd: 0 }, 9 * min), false, 'the first waits');
  assert.equal(due(200, { perpDepositedUsd: 0 }, 10 * min), true);
  assert.equal(due(24.9, { perpDepositedUsd: 0 }, 60 * min), false, 'the gate');
  assert.equal(due(200, { perpOpen: true, perpTrancheAt: now - 59 * min }), false);
  assert.equal(due(200, { perpOpen: true, perpTrancheAt: now - 60 * min }), true);
  assert.equal(due(200, { perpOpen: true, perpTrancheAt: now - 90 * min, perpDepositAt: now - 1 * min }), false, 'the one before is on its way');
  assert.equal(due(25, { perpOpen: false, perpTrancheAt: now - 5 * min, perpDepositAt: now - 6 * min }), true, 'closed by a take-profit');
  assert.equal(due(25, { perpOpen: false, perpTrancheAt: now - 90 * min, perpDepositAt: now - 2 * min }), false, 'on its way');
  assert.equal(due(25, { perpOpen: false, perpWithdrawIntentUsd: 30 }), false, 'its cash is being watched');
});

test('an open position takes no second tranche before the interval, except to finish one', async () => {
  const e = engine({ cash: 100 });
  await e.tick(); e.v.cash += 100; await e.tick();
  assert.equal(e.v.opens.length, 1);
  e.st.perpFilling = true; await e.tick();
  assert.equal(e.v.opens.length, 2);
  e.st.perpFilling = false; e.st.perpTrancheAt -= 3_600_000; e.v.cash += 100; await e.tick();
  assert.equal(e.v.opens.length, 3);
});

test('withdrawalOf: never more than the cash, funding owed taken off, the gain in proportion', () => {
  assert.deepEqual(withdrawalOf({ perpRealizedUsd: 6, perpCapitalUsd: 24 }, 100), { amount: 30, profit: 6 });
  assert.deepEqual(withdrawalOf({ perpRealizedUsd: 6, perpCapitalUsd: 24 }, 15), { amount: 15, profit: 3 });
  assert.deepEqual(withdrawalOf({ perpRealizedUsd: -1, perpCapitalUsd: 24 }, 100), { amount: 23, profit: 0 });
  assert.deepEqual(withdrawalOf({ perpRealizedUsd: 6, perpCapitalUsd: 24 }, -2), { amount: 0, profit: 0 });
  assert.deepEqual(withdrawalOf({ perpRealizedUsd: -3 }, 100), { amount: 0, profit: 0 });
});

test('splitArrival: 30% of the gain to the protocol, all of the capital buys back', () => {
  const BN = require('ethers').BigNumber.from;
  const x = splitArrival(BN(8_400_000), 8.4, 1.4); // $7 of fees at +20%
  assert.equal(x.toTreasury.add(x.toBuyback).toString(), '8400000', 'to the unit');
  assert.ok(Math.abs(x.toTreasury.toNumber() - 420_000) <= 2, x.toTreasury.toString());
  assert.equal(splitArrival(BN(5_000_000), 5, 5).toTreasury.toString(), '1500000', 'all gain, as before');
  assert.equal(splitArrival(BN(5_000_000), 5, 0).toTreasury.toString(), '0');
});

test('a withdrawal the venue accepted is never sent twice, whatever the cash does', async () => {
  const e = engine({ cash: 30, st: { perpRealizedUsd: 6, perpCapitalUsd: 24 } });
  await e.tick(); e.v.cash += 30; e.st.perpWithdrawAt -= 11 * 60_000;
  await e.tick();
  assert.deepEqual(e.v.pulls, [30]); assert.equal(e.st.perpWithdrawPendingUsd, 30);
});

test('funding is in the margin: what comes out is what the venue paid, whatever its sign', async () => {
  for (const funding of [-3, 3]) {
    const e = engine({ cash: 100 });
    await e.tick();
    e.v.margin += funding;
    const cash = e.v.cash;
    e.v.px = 111; await e.tick();
    close(e.st.perpCapitalUsd + e.st.perpRealizedUsd, e.v.cash - cash);
  }
});

test('a mature leftover below the minimum order does not stop new tranches', async () => {
  const e = engine({ cash: 60, st: { perpOpen: true, perpTranches: [{ base: 500, entryMark: 90, sizeDec: 4, ts: 1, leverage: 10 }] } });
  Object.assign(e.v, { units: 0.05, avg: 90, margin: 0.45, px: 111 });
  await e.tick();
  assert.equal(e.v.closes.length, 0); assert.equal(e.v.opens.length, 1);
});

test('a refused opening shrinks, and the rest follows without waiting', async () => {
  const e = engine({ cash: 100 });
  const send = lighter.open;
  lighter.open = async (o) => { if (o.notionalUsd > 300) { const x = new Error('excessive slippage'); x.definitive = true; throw x; } return send(o); };
  for (let i = 0; i < 12; i++) await e.tick();
  assert.ok(e.v.opens.length > 1 && e.v.cash < 12, `${e.v.opens} ${e.v.cash}`);
});

test('a deposit that cannot be made does not stop the take-profit', async () => {
  const e = engine({ cash: 100 });
  await e.tick();
  e.st.perpReserveRaw = '100000000'; e.st.perpTrancheAt = 0; e.v.px = 111;
  lighter.intentAddress = async () => { throw new Error('bridge down'); };
  await e.tick();
  assert.equal(e.v.closes.length, 1);
});

test('retired: the position is closed, all the cash withdrawn, nothing opened or split', async () => {
  const e = engine({ cash: 0, px: 100 });
  e.v.cash = 100; await e.tick();
  Object.assign(lighter, { enabled: true, marketById: async () => ({ symbol: 'BTC', index: 1, sizeDec: 4, minBaseUnits: 1, minQuoteUsd: 10 }) });
  const quote = { balanceOf: async () => require('ethers').BigNumber.from(0) };
  const go = () => require('../keeper').retireTick(null, { ...e.coin, venue: undefined }, e.st, () => {}, { address: '0x1' }, 1, quote);
  e.v.px = 97; e.st.perpRealizedUsd = 8; e.v.cash += 5;
  await go(); assert.equal(e.v.units, 0);
  const all = e.v.cash;
  await go(); close(e.v.pulls[0], all, 1e-5);
  for (let i = 0; i < 4; i++) await go();
  assert.equal(e.v.pulls.length, 1); assert.equal(e.v.opens.length, 1);
  assert.equal(e.st.perpWithdrawPendingProfitUsd, 0);
});
