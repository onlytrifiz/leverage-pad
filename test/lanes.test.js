const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const config = require('../config');
const { createLanes, createMutex, createSemaphore } = require('../lib/lanes');
const { createStore } = require('../lib/store');
const rest = require('../lighter/rest');
const { reasonToTick, sendNow, refusedByNode, moving, settleTxOut } = require('../keeper');

const BN = ethers.BigNumber.from;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── lanes ────────────────────────────────────────────────────────────────────
test('lanes: side by side, never two on the same token', async () => {
  const lanes = createLanes();
  let now = 0, most = 0;
  const seen = [];
  const work = async (k) => { now++; most = Math.max(most, now); seen.push(k); await sleep(10); now--; };
  await lanes.round(['a', 'b', 'c', 'd', 'e'], { key: (k) => k, work, parallel: 2, patienceMs: 1_000 });
  assert.equal(most, 2); assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd', 'e']);
  let inside = 0;
  const first = lanes.run('x', async () => { inside++; await sleep(20); inside--; });
  assert.equal(await lanes.run('x', async () => { assert.fail('two on x'); }), false);
  assert.equal(lanes.isBusy('x'), true);
  await first;
  assert.equal(lanes.isBusy('x'), false); assert.equal(inside, 0);
});

test('lanes: one that hangs is left behind, still busy, and everybody else is served', async () => {
  const lanes = createLanes({ log: () => {} });
  let free;
  const done = [];
  const work = async (k) => { if (k === 'hung') await new Promise((r) => { free = r; }); done.push(k); };
  const t = Date.now();
  await lanes.round(['hung', 'a', 'b', 'c'], { key: (k) => k, work, parallel: 1, patienceMs: 30 });
  assert.ok(Date.now() - t < 500); assert.deepEqual(done, ['a', 'b', 'c']);
  assert.equal(lanes.isBusy('hung'), true);
  await lanes.round(['hung', 'a'], { key: (k) => k, work, parallel: 2, patienceMs: 30 });
  assert.deepEqual(done, ['a', 'b', 'c', 'a'], 'not a second time while the first is at it');
  free(); await sleep(5);
  assert.equal(lanes.isBusy('hung'), false); assert.equal(done.at(-1), 'hung');
});

test('lanes: a token that throws does not stop the round, and is free again', async () => {
  const lanes = createLanes({ log: () => {} });
  const done = [];
  await lanes.round(['bad', 'a'], { key: (k) => k, work: async (k) => { if (k === 'bad') throw new Error('x'); done.push(k); }, parallel: 1, patienceMs: 100 });
  assert.deepEqual(done, ['a']); assert.equal(lanes.isBusy('bad'), false);
});

test('mutex: one at a time and in order per name, a failure does not break the line', async () => {
  const m = createMutex(), log = [];
  const job = (id, ms, fail) => async () => { log.push(`>${id}`); await sleep(ms); log.push(`<${id}`); if (fail) throw new Error(id); return id; };
  const all = await Promise.allSettled([m('k', job(1, 15)), m('k', job(2, 1, true)), m('k', job(3, 1)), m('other', job(4, 1))]);
  assert.deepEqual(all.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(log.filter((x) => !x.endsWith('4')), ['>1', '<1', '>2', '<2', '>3', '<3']);
  assert.ok(log.indexOf('<4') < log.indexOf('<1'));
});

test('semaphore: never more than n', async () => {
  const s = createSemaphore(2);
  let now = 0, most = 0;
  await Promise.allSettled(Array.from({ length: 7 }, (_, i) => s(async () => { now++; most = Math.max(most, now); await sleep(4); now--; if (i === 3) throw new Error('x'); })));
  assert.equal(most, 2); assert.equal(now, 0);
});

test('semaphore: who is in front goes before who waited longer', async () => {
  const s = createSemaphore(1), got = [];
  const job = (n) => async () => { got.push(n); await sleep(3); };
  await Promise.all([s(job('a')), s(job('b')), s(job('c')), s(job('urgent'), { front: true })]);
  assert.deepEqual(got, ['a', 'urgent', 'b', 'c']);
});

// ── transactions ─────────────────────────────────────────────────────────────
/** a node in the test's hands */
function node(over = {}) {
  const n = { sent: [], mined: new Map(), nonce: 5, ...over };
  n.provider = {
    _isProvider: true, getGasPrice: async () => BN(1), getNetwork: async () => ({ chainId: 4663 }), estimateGas: async () => BN(21_000),
    getTransactionCount: async () => n.nonce,
    sendTransaction: async (raw) => { const h = ethers.utils.keccak256(raw); n.sent.push(h); return n.take ? n.take(h, raw) : n.mine(h); },
    getTransaction: async (h) => { if (n.deaf) throw new Error('down'); return n.mined.get(h) ?? null; },
    getTransactionReceipt: async (h) => { if (n.deaf) throw new Error('down'); return n.mined.get(h) ?? null; },
  };
  n.mine = (h, status = 1) => { n.mined.set(h, { status, blockNumber: 1, transactionHash: h }); n.nonce++; };
  const w = new ethers.Wallet('0x' + '11'.repeat(32), n.provider);
  w.populateTransaction = async (t) => ({ to: t.to, value: t.value ?? 0, gasLimit: t.gasLimit, data: t.data, nonce: t.nonce ?? n.nonce, chainId: 4663, gasPrice: BN(1) });
  n.wallet = w;
  return n;
}
const lost = () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
const quick = async (fn) => { const keep = config.WAIT_TIMEOUT_MS; config.WAIT_TIMEOUT_MS = 900; try { return await fn(); } finally { config.WAIT_TIMEOUT_MS = keep; } };
const TX = { to: '0x' + '22'.repeat(20), gasLimit: 21_000, value: 0 };

test('send: only a receipt, or the node refusing a transaction it has not got, is an outcome', () => quick(async () => {
  const run = async (n) => sendNow(n.wallet, TX, 'x').catch((e) => e);
  assert.equal((await run(node())).status, 1);
  const n1 = node(); n1.take = (h) => { n1.mine(h); lost(); };
  assert.equal((await run(n1)).status, 1, 'no answer, and it was in');
  const n2 = node({ take: lost }); assert.equal((await run(n2)).stuck, true, 'no answer, and not seen: unknown');
  const n3 = node(); n3.take = (h) => { n3.mine(h); n3.deaf = true; setTimeout(() => { n3.deaf = false; }, 300); };
  assert.equal((await run(n3)).status, 1, 'a receipt that could not be read is read again');
  const n4 = node(); n4.take = (h) => n4.mine(h, 0);
  const bad = await run(n4); assert.match(bad.message, /revertata/); assert.equal(bad.stuck, undefined);
  const say = (message, code = -32000) => () => { throw Object.assign(new Error('node'), { body: JSON.stringify({ error: { code, message } }) }); };
  for (const m of ['max fee per gas less than block base fee: x', 'insufficient funds for gas', 'intrinsic gas too low']) assert.equal((await run(node({ take: say(m) }))).stuck, undefined, m);
  for (const m of ['already known', 'nonce too low: next nonce 7', 'upstream timeout', 'context deadline exceeded', 'internal error']) assert.equal((await run(node({ take: say(m) }))).stuck, true, m);
  const n5 = node(); n5.take = (h) => { n5.mine(h); say('nonce too low')(); };
  assert.equal((await run(n5)).status, 1, 'refused the second time a gateway tried it');
  assert.equal(refusedByNode({ code: 'SERVER_ERROR', body: '<html>502' }), false); assert.equal(refusedByNode(new Error('x')), false);
}));

test('moving: out of its bucket until known, the same transaction again, and given back only when it cannot happen', () => quick(async () => {
  const coin = { symbol: 'T' }, log = console.log; console.log = () => {};
  const start = () => ({ st: { treasuryOwedRaw: '30', perpDepositAt: 7 }, disk: null });
  const go = (c, n, extra) => moving({ st: c.st, checkpoint: () => { c.disk = JSON.parse(JSON.stringify(c.st)); }, wallet: n.wallet, bucket: 'treasuryOwedRaw', raw: BN(30), tx: TX, label: 'p', extra });
  const settle = (c, n) => settleTxOut({ coin, st: c.st, checkpoint: () => { c.disk = JSON.parse(JSON.stringify(c.st)); }, wallet: n.wallet });
  try {
    let c = start(), n = node();
    await go(c, n); assert.deepEqual([c.disk.treasuryOwedRaw, c.disk.txOut], ['0', null]);
    c = start(); n = node({ take: () => { throw Object.assign(new Error('x'), { code: 'INSUFFICIENT_FUNDS' }); } });
    await assert.rejects(go(c, n)); assert.deepEqual([c.disk.treasuryOwedRaw, c.disk.txOut], ['30', null]);
    // no answer, and it never landed: nobody touches the bucket, the SAME transaction goes again
    c = start(); n = node({ take: lost });
    await assert.rejects(go(c, n), (e) => e.stuck === true);
    assert.equal(c.disk.treasuryOwedRaw, '0'); assert.ok(c.disk.txOut.raw);
    c.st = JSON.parse(JSON.stringify(c.disk)); // killed and born again
    assert.equal(await settle(c, n), false); assert.equal(new Set(n.sent).size, 1);
    n.take = null; assert.equal(await settle(c, n), false); // this one lands
    assert.equal(await settle(c, n), true); assert.deepEqual([c.disk.treasuryOwedRaw, c.disk.txOut], ['0', null]);
    // killed after recording it and before signing
    c = start(); c.st = { treasuryOwedRaw: '0', txOut: { bucket: 'treasuryOwedRaw', amountRaw: '30', label: 'p' } }; n = node();
    assert.equal(await settle(c, n), true); assert.equal(c.st.treasuryOwedRaw, '30');
    // its nonce went to another: given back, not at the first look
    c = start(); n = node({ take: lost }); await assert.rejects(go(c, n)); n.nonce = 9;
    assert.equal(await settle(c, n), false); assert.equal(c.st.treasuryOwedRaw, '0');
    c.st.txOut.usedAt -= 61_000; assert.equal(await settle(c, n), true); assert.equal(c.st.treasuryOwedRaw, '30');
    // reverted; a deposit's own figures
    c = start(); n = node({ take: lost }); await assert.rejects(go(c, n, { depositedUsd: 4, perpDepositAt: 3 })); n.mine(c.st.txOut.hash, 0);
    assert.equal(await settle(c, n), true); assert.deepEqual([c.st.treasuryOwedRaw, c.st.perpDepositAt, c.st.perpDepositedUsd], ['30', 3, undefined]);
    c = start(); n = node({ take: lost }); await assert.rejects(go(c, n, { depositedUsd: 4, perpDepositAt: 3 })); n.mine(c.st.txOut.hash);
    assert.equal(await settle(c, n), true); assert.deepEqual([c.st.treasuryOwedRaw, c.st.perpDepositedUsd], ['0', 4]);
    // a price nobody takes: after a while its nonce is used for nothing
    c = start(); n = node({ take: lost }); await assert.rejects(go(c, n)); c.st.txOut.at -= config.TX_GIVE_UP_MS + 1;
    const before = n.sent.length; n.take = (h) => { if (h !== c.st.txOut.hash) n.mine(h); else lost(); };
    assert.equal(await settle(c, n), false); assert.equal(n.sent.length, before + 2); assert.equal(n.nonce, 6);
    await settle(c, n); c.st.txOut.usedAt -= 61_000; assert.equal(await settle(c, n), true); assert.equal(c.st.treasuryOwedRaw, '30');
    // a nonce before it that nobody used: the first free one, pass after pass
    c = start(); n = node({ take: lost, nonce: 6 }); await assert.rejects(go(c, n)); c.st.txOut.at -= config.TX_GIVE_UP_MS + 1;
    n.nonce = 5; n.take = (h) => { if (h !== c.st.txOut.hash) n.mine(h); else lost(); };
    for (let i = 0; i < 3; i++) await settle(c, n);
    assert.equal(n.nonce, 7); c.st.txOut.usedAt -= 61_000; assert.equal(await settle(c, n), true); assert.equal(c.st.treasuryOwedRaw, '30');
    // nothing known while the node is down
    c = start(); n = node({ take: lost }); await assert.rejects(go(c, n)); n.deaf = true;
    await assert.rejects(settle(c, n)); assert.equal(c.st.treasuryOwedRaw, '0');
  } finally { console.log = log; }
}));

test('semaphore: one place is only for the urgent, however slow the others are', async () => {
  const s = createSemaphore(3, { reserved: 1 }), got = [];
  let free;
  const gate = new Promise((r) => { free = r; });
  const slow = Array.from({ length: 5 }, (_, i) => s(async () => { got.push(i); await gate; }));
  await sleep(1); assert.deepEqual(got, [0, 1]);
  const t = Date.now(); await s(async () => { got.push('u'); }, { front: true });
  assert.ok(Date.now() - t < 50); assert.deepEqual(got, [0, 1, 'u']);
  free(); await Promise.all(slow); assert.equal(got.length, 6);
});

test('mutex: says how long whoever is in has been in', async () => {
  const m = createMutex();
  assert.equal(m.heldFor('k'), 0);
  const p = m('k', () => sleep(30)); await sleep(15);
  assert.ok(m.heldFor('k') >= 10); await p; assert.equal(m.heldFor('k'), 0);
});

// ── store ────────────────────────────────────────────────────────────────────
const reg0 = () => ({ coins: [{ token: '0xAa', symbol: 'A' }, { token: '0xBb', symbol: 'B' }], state: { '0xaa': { n: 1 }, '0xbb': { n: 1 }, '0xold': { n: 9 } }, routerScanBlock: 5 });

test('store: the checkpoint of one token never writes another in the middle of its work', () => {
  let disk;
  const store = createStore(reg0(), { write: (_, t) => { disk = JSON.parse(t); } });
  const { reg } = store;
  reg.state['0xbb'].n = 2; // b has begun, and has not reached its checkpoint
  reg.state['0xaa'].n = 3;
  store.commit('0xAa');
  assert.deepEqual(disk.state, { '0xaa': { n: 3 }, '0xbb': { n: 1 }, '0xold': { n: 9 } });
  store.commit('0xbb');
  assert.equal(disk.state['0xbb'].n, 2);
  assert.deepEqual(disk.coins.map((c) => c.symbol), ['A', 'B']); assert.equal(disk.routerScanBlock, 5);
  assert.deepEqual(store.committed(), disk);
});

test('store: new tokens, the router\'s changes and what belongs to nobody', () => {
  let disk;
  const store = createStore(reg0(), { write: (_, t) => { disk = JSON.parse(t); } });
  const { reg } = store;
  reg.coins.push({ token: '0xCc' }); reg.state['0xcc'] = { n: 0 }; reg.routerScanBlock = 9;
  reg.coins[0].symbol = 'A2'; reg.state['0xaa'].n = 7; reg.coins[1].symbol = 'B2'; reg.state['0xbb'].n = 7;
  store.commitCoins((k) => k === '0xaa');
  assert.equal(disk.coins[0].symbol, 'A'); assert.equal(disk.state['0xaa'].n, 1, 'at work: its own checkpoint will write it');
  assert.equal(disk.coins[1].symbol, 'B2'); assert.equal(disk.state['0xbb'].n, 7);
  assert.equal(disk.coins[2].token, '0xCc'); assert.equal(disk.routerScanBlock, 9);
  reg.coins.push({ token: '0xDd' }); reg.state['0xdd'] = {}; reg.routerScanBlock = 12; reg.flywheel = { owedRaw: '5' };
  store.commitRest();
  assert.equal(disk.coins.length, 4, 'the cursor is never written without the tokens it has found');
  assert.equal(disk.flywheel.owedRaw, '5');
});

test('store: an empty registry is a valid file', () => {
  let disk;
  const store = createStore({ coins: [], state: {} }, { write: (_, t) => { disk = JSON.parse(t); } });
  store.commitRest(); assert.deepEqual(disk, { coins: [], state: {} });
});

// ── reads ────────────────────────────────────────────────────────────────────
test('limiter: so many a minute, urgent ones first', async () => {
  let t = 0;
  const timers = [];
  const l = rest.createLimiter({ perMinute: 2, now: () => t, setTimer: (fn, ms) => { timers.push([t + ms, fn]); return { }; } });
  const got = [];
  const ask = (n) => l.slot().then(() => got.push(n));
  ask(1); ask(2); ask(3); ask(4); rest.urgently(() => ask('u'));
  await sleep(1);
  assert.deepEqual(got, [1, 2]); assert.equal(l.waiting(), 3);
  t = 60_000; timers.forEach(([, f]) => f()); await sleep(1);
  assert.deepEqual(got, [1, 2, 'u', 3]);
  t = 61_000; l.pause(15_000);
  t = 120_001; timers.slice(-1).forEach(([, f]) => f()); await sleep(1);
  assert.deepEqual(got, [1, 2, 'u', 3, 4]);
});

async function withFetch(answers, fn) {
  const real = globalThis.fetch, asked = [];
  globalThis.fetch = async (url) => { asked.push(url); const a = answers.shift(); if (a instanceof Error) throw a; return { ok: (a.status ?? 200) === 200, status: a.status ?? 200, json: async () => a.body }; };
  try { return [await fn(), asked]; } finally { globalThis.fetch = real; }
}
const ACC = { index: 56415, collateral: '0.12', available_balance: '0.80', positions: [{ market_id: 15, sign: 1, position: '0.8640', avg_entry_price: '143.32', unrealized_pnl: '0.69', allocated_margin: '6.19', liquidation_price: '140.3', total_funding_paid_out: '-0.0003' }] };

test('account: the shape the sidecar gave, and never an empty one for a bad answer', async () => {
  const [a] = await withFetch([{ body: { code: 200, accounts: [ACC] } }], () => rest.account({ accountIndex: 56415 }));
  assert.deepEqual(a.positions[0], { market_id: 15, sign: 1, size: '0.8640', avg_entry_price: '143.32', unrealized_pnl: '0.69', allocated_margin: '6.19', liquidation_price: '140.3', total_funding_paid_out: '-0.0003' });
  assert.equal(a.collateral, '0.12'); assert.equal(a.available_balance, '0.80');
  for (const body of [{ code: 200, accounts: [] }, { code: 200 }, { code: 200, accounts: [{ ...ACC, index: 1 }] }, { code: 200, accounts: [{ ...ACC, positions: null }] }, { code: 200, accounts: [{ ...ACC, collateral: undefined }] }, { code: 500, message: 'x' }])
    await assert.rejects(withFetch([{ body }], () => rest.account({ accountIndex: 56415 })));
  await assert.rejects(withFetch([{ status: 502, body: {} }], () => rest.account({ accountIndex: 1 })), /502/);
  await assert.rejects(withFetch([new Error('socket')], () => rest.account({ accountIndex: 1 })), /socket/);
});

test('fills: one order, both sides, across pages, until before it was sent', async () => {
  const t = (cid, size, price, at, side = 'ask') => ({ [`${side}_account_id`]: 7, [`${side}_client_id`]: cid, [`${side === 'ask' ? 'bid' : 'ask'}_account_id`]: 9, [`${side === 'ask' ? 'bid' : 'ask'}_client_id`]: cid, size: String(size), price: String(price), timestamp: at });
  const [r, asked] = await withFetch([
    { body: { code: 200, trades: [t(5, 1, 100, 900_000), t(6, 9, 1, 900_000), t(5, 1, 110, 890_000, 'bid')], next_cursor: 'p2' } },
    { body: { code: 200, trades: [t(5, 2, 120, 880_000), t(1, 1, 1, 100_000)], next_cursor: 'p3' } },
  ], () => rest.fills({ accountIndex: 7, marketIndex: 1, clientOrderIndex: 5, since: 870_000 }));
  assert.equal(r.size, 4); assert.equal(r.price, (100 + 110 + 240) / 4); assert.equal(asked.length, 2); assert.match(asked[1], /cursor=p2/);
  const [none] = await withFetch([{ body: { code: 200, trades: [] } }], () => rest.fills({ accountIndex: 7, marketIndex: 1, clientOrderIndex: 5 }));
  assert.deepEqual([none.size, none.price], [0, null]);
  await assert.rejects(withFetch([{ body: { code: 200 } }], () => rest.fills({ accountIndex: 7, marketIndex: 1, clientOrderIndex: 5 })), /incomplete/);
});

test('a read carries the token of the account it is about, on that account\'s allowance', async () => {
  const real = globalThis.fetch, asked = [];
  let refuse = new Set();
  globalThis.fetch = async (url, o) => {
    const id = Number(new URL(url).searchParams.get('value')), token = o.headers.authorization ?? null;
    asked.push([id, token]);
    if (token && refuse.has(token)) return { ok: false, status: 401, json: async () => ({ code: 20013, message: 'invalid auth: expired token' }) };
    return { ok: true, status: 200, json: async () => ({ code: 200, accounts: [{ ...ACC, index: id }] }) };
  };
  try {
    const told = [];
    let fresh = '';
    rest.useTokens((id) => (id < 900 ? `t${id}${fresh}` : null), (id, t) => told.push([id, t]));
    const spare = rest.spareReads();
    for (const id of [701, 702, 701]) await rest.account({ accountIndex: id });
    assert.deepEqual(asked, [[701, 't701'], [702, 't702'], [701, 't701']]);
    assert.equal(rest.spareReads(), spare, 'nothing of everybody\'s was used');
    assert.equal(rest.authed(701), true); assert.equal(rest.authed(950), false); assert.equal(rest.authed(null), false);
    await rest.account({ accountIndex: 950 });
    assert.deepEqual(asked.at(-1), [950, null]); assert.equal(rest.spareReads(), spare - 1);
    // a token the venue will not have: the read goes without it, and so do the next ones
    refuse = new Set(['t703']); asked.length = 0;
    await rest.account({ accountIndex: 703 }); await rest.account({ accountIndex: 703 });
    assert.deepEqual(asked, [[703, 't703'], [703, null], [703, null]]); assert.equal(rest.authed(703), false);
    assert.deepEqual(told, [[703, 't703']], 'said once');
    fresh = 'b'; await rest.account({ accountIndex: 703 }); assert.deepEqual(asked.at(-1), [703, 't703b'], 'its replacement is used at once'); fresh = '';
    await rest.account({ accountIndex: 704 }); assert.deepEqual(asked.at(-1), [704, 't704'], 'nobody else\'s');
    // forty accounts at once: each on its own
    asked.length = 0; const before = rest.spareReads();
    await Promise.all(Array.from({ length: 40 }, (_, i) => rest.account({ accountIndex: 800 + i })));
    assert.equal(asked.length, 40); assert.equal(rest.spareReads(), before);
    rest.charge(3, 801); assert.equal(rest.spareReads(), before); rest.charge(3, 951); assert.equal(rest.spareReads(), before - 3);
  } finally { globalThis.fetch = real; rest.useTokens(() => null); }
});

test('resolveAccount and markets: not found is an answer, incomplete is not', async () => {
  assert.deepEqual((await withFetch([{ status: 400, body: { code: 21100, message: 'account not found' } }], () => rest.resolveAccount({ address: '0x1' })))[0].accountIndex, null);
  assert.equal((await withFetch([{ body: { code: 200, sub_accounts: [{ index: 9 }, { index: 4 }] } }], () => rest.resolveAccount({ address: '0x1' })))[0].accountIndex, 4);
  await assert.rejects(withFetch([{ status: 500, body: { message: 'down' } }], () => rest.resolveAccount({ address: '0x1' })));
  const book = { symbol: 'NVDA', market_id: 15, supported_size_decimals: 4, supported_price_decimals: 2, min_base_amount: '0.04', min_quote_amount: '10', status: 'active' };
  const [m] = await withFetch([{ body: { code: 200, order_books: [book] } }, { body: { code: 200, order_book_details: [{ symbol: 'NVDA', min_initial_margin_fraction: 500 }] } }], () => rest.markets());
  assert.deepEqual(m.markets.NVDA, { index: 15, size_dec: 4, price_dec: 2, min_base: '0.04', min_quote: '10', status: 'active', min_imf: 500 });
  const [n] = await withFetch([{ body: { code: 200, order_books: [book] } }, new Error('x')], () => rest.markets());
  assert.equal(n.markets.NVDA.min_imf, undefined);
  await assert.rejects(withFetch([{ body: { code: 200, order_books: [] } }], () => rest.markets()));
});

// ── who a round goes to ──────────────────────────────────────────────────────
test('reasonToTick: nothing to do is skipped, anything to do or unknown is not', () => {
  Object.assign(config, { OPEN_GATE_USD: 25, TOPUP_STEP_USD: 25, TRANCHE_INTERVAL_MS: 3_600_000, FIRST_OPEN_DELAY_MS: 600_000, PERP_WITHDRAW_FLOOR_USD: 20, BUYBACK_FLOOR_USD: 20 });
  const now = 1_800_000_000_000;
  const coin = { token: '0x' + 'ab'.repeat(20), venue: 'v4', sink: '0x1', sinkAdopted: true, pairDecimals: 6, market: 'NVDA', side: 'long', leverage: 20, managed: true, createdAt: new Date(0).toISOString() };
  const st = { perpLookAt: now - 1_000, lighterAccountIndex: 5, lighterLeverage: 20, perpEngine: { market: 'NVDA', side: 'long' }, perpReserveRaw: '0', buybackReserveRaw: '0', treasuryOwedRaw: '0', creatorOwedRaw: '0', perpTranches: [{ base: 1 }], perpOpen: true, perpDepositedUsd: 100, perpTrancheAt: now - 1_000, perpDepositAt: now - 60_000 };
  const brief = { quoteRaw: BN(0), coinRaw: BN(0), sinkRaw: BN(0), sinkCoinRaw: BN(0), hookRaw: BN(0) };
  const why = (s = {}, b = {}, c = {}, feedLive = true) => reasonToTick({ coin: { ...coin, ...c }, st: { ...st, ...s }, brief: b === null ? null : { ...brief, ...b }, feedLive, now });
  assert.equal(why(), null);
  assert.equal(why({ perpLookAt: now - 5 * 60_000 }), 'look');
  assert.equal(why({}, null), 'unread'); assert.equal(why({ perpOrder: { id: 1 } }, null), 'in flight', 'what is known from the books does not need the chain');
  assert.equal(why({}, { sinkRaw: BN(600_000) }), 'fees'); assert.equal(why({}, { sinkRaw: BN(400_000) }), null);
  assert.equal(why({}, { sinkCoinRaw: BN(1) }), 'fees'); assert.equal(why({}, { hookRaw: BN(1) }), 'hook'); assert.equal(why({}, { coinRaw: BN(1) }), 'burn');
  assert.equal(why({}, { quoteRaw: BN(600_000) }), 'surplus');
  assert.equal(why({ perpReserveRaw: '600000' }, { quoteRaw: BN(600_000) }), null);
  assert.equal(why({ perpWithdrawPendingUsd: 5 }), 'arrival'); assert.equal(why({ buybackReserveRaw: '20000000' }), 'buyback'); assert.equal(why({ treasuryOwedRaw: '1000000' }), 'payout');
  assert.equal(why({ perpOrder: { id: 1 } }), 'in flight'); assert.equal(why({ perpWithdrawIntentUsd: 3 }), 'in flight');
  assert.equal(why({ perpReserveRaw: '30000000', perpTrancheAt: now - 3_600_000, perpDepositAt: now - 3_700_000 }), 'deposit'); assert.equal(why({ perpReserveRaw: '30000000' }), null, 'the interval');
  assert.equal(why({ perpDepositAt: now - 500 }), 'deposit on its way');
  assert.equal(why({ perpSwitch: {} }), 'switch'); assert.equal(why({}, {}, { side: 'short' }), 'switch'); assert.equal(why({ perpCarry: true }), 'switch');
  assert.equal(why({ perpFilling: true }), 'unfinished'); assert.equal(why({ perpTpSplit: 1 }), 'unfinished');
  config.PAUSED.add(coin.token); assert.equal(why({ perpOrder: { id: 1 } }, { sinkRaw: BN(600_000_000) }), null, 'paused: nothing at all'); config.PAUSED.delete(coin.token);
  assert.equal(why({ perpRealizedUsd: 5, perpCapitalUsd: 16 }), 'withdrawal'); assert.equal(why({ perpRealizedUsd: 5, perpCapitalUsd: 16, perpWithdrawRetryAt: now + 1 }), null);
  assert.equal(why({}, {}, { leverage: 10 }), 'leverage'); assert.equal(why({ lighterLeverageRejected: 10 }, {}, { leverage: 10 }), null);
  assert.equal(why({}, {}, {}, false), 'no marks'); assert.equal(why({ perpTranches: [] }, {}, {}, false), null);
  assert.equal(why({ lighterAccountIndex: null, perpDepositedUsd: 0 }), null); assert.equal(why({ lighterAccountIndex: null }), 'account');
  assert.equal(why({}, {}, { sinkAdopted: false }), 'setup'); assert.equal(why({}, {}, { venue: undefined }), 'setup');
  assert.equal(why({}, {}, { engineError: 'x' }), null);
  config.RETIRED.add(coin.token);
  assert.equal(why({ perpOpen: false }), null); assert.equal(why({ perpOpen: false }, { quoteRaw: BN(600_000) }), 'retired'); assert.equal(why(), 'retired');
  config.RETIRED.delete(coin.token);
});

// last: it leaves the shared limiter paused
test('a 429 pauses the reads even when it comes without a body', async () => {
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => { asked++; return { ok: false, status: 429, json: async () => { throw new Error('not json'); } }; };
  try {
    await assert.rejects(rest.account({ accountIndex: 1 }), /429/);
    const late = rest.account({ accountIndex: 1 }).catch(() => {});
    await sleep(30);
    assert.equal(asked, 1, 'nobody asks while it is paused');
    void late;
  } finally { globalThis.fetch = real; }
});
test.after(() => setTimeout(() => process.exit(), 50).unref());

test('a paused token is left alone: nothing read, sent or traded', async () => {
  const { tickCoin, hasMature } = require('../keeper');
  const token = '0x' + 'cd'.repeat(20);
  const coin = { token, symbol: 'P', pair: config.USDG, pairSymbol: 'USDG', pairDecimals: 6, venue: 'v4', sink: '0x1', sinkAdopted: true, market: 'NVDA', side: 'long', leverage: 20, takeProfitPct: 50 };
  const st = { perpTranches: [{ base: 1, entryMark: 100, ts: 1, leverage: 20 }], perpOpen: true, lastTickTs: 0 };
  const touch = new Proxy({}, { get: () => { throw new Error('touched'); } });
  config.PAUSED.add(token);
  try {
    await tickCoin(touch, touch, coin, st, () => { throw new Error('nothing to save'); });
    assert.ok(st.lastTickTs > 0);
    assert.equal(hasMature(coin, st, 1000), false);
  } finally { config.PAUSED.delete(token); }
  assert.equal(hasMature(coin, st, 1000), true, 'and once taken off the list it is served again');
});
