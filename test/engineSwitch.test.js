const test = require('node:test');
const assert = require('node:assert/strict');
const lighter = require('../lighter/client');
const { strayPositions, switchCredit, settleEngineSwitch } = require('../keeper');

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

function venue({ positions, cash = 0, slip = 0, refuse = () => false, fill = (n) => n }) {
  const v = { positions: positions.map((p) => ({ ...p })), cash, closes: [], reads: 0 };
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

test('switchCredit: the book less the slippage the account paid, never negative', () => {
  assert.equal(switchCredit({ bookPnl: 50, equityBefore: 1000, equityAfter: 1000 }), 50);
  assert.equal(switchCredit({ bookPnl: 50, equityBefore: 1000, equityAfter: 980 }), 30);
  assert.equal(switchCredit({ bookPnl: 50, equityBefore: 1000, equityAfter: 900 }), 0);
  assert.equal(switchCredit({ bookPnl: -20, equityBefore: 1000, equityAfter: 1000 }), 0);
  assert.equal(switchCredit({ bookPnl: 50, equityBefore: 1000, equityAfter: 1400 }), 50, 'a deposit in between is not profit');
  assert.equal(switchCredit({ bookPnl: 50, equityBefore: NaN, equityAfter: NaN }), 50);
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

test('partial fill: the filled part is banked once, the rest waits with its tranches', async () => {
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }], fill: (n) => Math.min(n, 4) });
  const c = setup();
  await settleEngineSwitch(c);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 80) < 1e-6);
  assert.equal(c.st.perpTranches[0].base, 6_0000);
  assert.equal(c.st.perpOpen, true);
  await settleEngineSwitch(c); await settleEngineSwitch(c);
  assert.ok(Math.abs(c.st.perpRealizedUsd - 200) < 1e-6, 'the total, once');
  assert.equal(await settleEngineSwitch(c), false);
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

test('closed but the read after it failed: no credit, the tranches go with the position', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  const read = lighter.account;
  let n = 0;
  lighter.account = async () => { if (++n === 3) throw new Error('503'); return read(); };
  const c = setup();
  assert.equal(await settleEngineSwitch(c), true);
  assert.equal(v.positions[0].units, 0);
  assert.equal(await settleEngineSwitch(c), false);
  assert.deepEqual(c.st.perpTranches, []);
  assert.equal(c.st.perpRealizedUsd, 0);
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
  const v = venue({ positions: [{ id: 15, sign: 1, units: 0.01, entry: 100, mark: 100, margin: 0 }], refuse: () => true });
  const c = setup({ coin: { market: 'ANT', side: 'long' }, ctx: { marketIndex: 4108 }, st: { perpTranches: [] } });
  assert.equal(await settleEngineSwitch(c), true);
  assert.equal(await settleEngineSwitch(c), false, 'left alone');
  v.positions[0].units = 2;
  c.st.perpEngine = { market: 'NVDA', side: 'long' };
  assert.equal(await settleEngineSwitch(c), true, 'no longer dust');
});

test('an engine pointed at a market the venue does not list: the old position still closes', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  const c = setup({ coin: { market: 'NOPE', side: 'long' }, ctx: { marketIndex: null } });
  assert.equal(await settleEngineSwitch(c), true);
  assert.equal(v.positions[0].units, 0);
});

test('funding charged since the last read is settled before the position disappears', async () => {
  venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 100, margin: 100, funding: -3 }] });
  const c = setup();
  await settleEngineSwitch(c);
  assert.equal(c.st.perpRealizedUsd, -3);
});

test('simulate: reads only', async () => {
  const v = venue({ positions: [{ id: 15, sign: 1, units: 10, entry: 100, mark: 120, margin: 100 }] });
  assert.equal(await settleEngineSwitch(setup({ ctx: { sim: true } })), true);
  assert.equal(v.closes.length, 0);
});
