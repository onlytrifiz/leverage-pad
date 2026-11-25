const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeed, createUrgent } = require('../lib/marketFeed');
const { hasMature } = require('../keeper');
const config = require('../config');

/** a socket in the test's hands */
class Socket {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; Socket.all.push(this); }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; this.onopen(); }
  say(m) { this.onmessage({ data: typeof m === 'string' ? m : JSON.stringify(m) }); }
  mark(id, mark) { this.say({ type: 'update/market_stats', channel: `market_stats:${id}`, market_stats: { market_id: id, mark_price: String(mark) } }); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const make = (over = {}) => {
  Socket.all = [];
  const got = [];
  const feed = createFeed({ url: 'wss://x', WebSocketImpl: Socket, log: () => {}, onMark: (id, m) => got.push([id, m]), ...over });
  return { feed, got };
};

test('feed: subscribes to what is watched, and only to that', () => {
  const { feed, got } = make();
  feed.watch([]);
  assert.equal(Socket.all.length, 0, 'nothing to hear, no connection');
  feed.watch([1, 15]);
  const s = Socket.all[0];
  s.open();
  assert.deepEqual(s.sent.map((m) => [m.type, m.channel]), [['subscribe', 'market_stats/1'], ['subscribe', 'market_stats/15']]);
  s.mark(15, 142.5); s.mark(99, 1);
  assert.deepEqual(got, [[15, 142.5]]);
  feed.watch([15, 3]);
  assert.deepEqual(s.sent.slice(2).map((m) => [m.type, m.channel]), [['subscribe', 'market_stats/3'], ['unsubscribe', 'market_stats/1']]);
  feed.stop();
});

test('feed: what is not a mark is ignored, a ping is answered, a handler that throws does not kill it', () => {
  const { feed, got } = make();
  feed.watch([1]); const s = Socket.all[0]; s.open();
  s.say('not json'); s.say({ type: 'connected' }); s.say({ type: 'update/market_stats', market_stats: { market_id: 1, mark_price: 'x' } }); s.mark(1, 0); s.mark(1, -5);
  assert.deepEqual(got, []);
  s.say({ type: 'ping' });
  assert.equal(s.sent.at(-1).type, 'pong');
  s.mark(1, 10); assert.equal(got.length, 1);
  feed.stop();
  const bad = make({ onMark: () => { throw new Error('boom'); } });
  bad.feed.watch([1]); Socket.all[0].open(); Socket.all[0].mark(1, 5);
  assert.equal(bad.feed.live(), true);
  bad.feed.stop();
});

test('feed: the line is kept up with a ping, whose answer is not a word from the markets', async () => {
  let t = 0;
  const { feed } = make({ pingMs: 5, now: () => t });
  feed.watch([1]); const s = Socket.all[0];
  await tick(20); assert.equal(s.sent.length, 0, 'not before it is open');
  s.open(); await tick(30);
  assert.ok(s.sent.filter((m) => m.type === 'ping').length >= 2);
  t = 19_000; s.mark(1, 5); t = 45_000; s.say({ type: 'pong' });
  await tick(5_100);
  assert.equal(feed.live(), false, 'only pongs: a dead line');
  feed.stop(); const n = s.sent.length; await tick(20); assert.equal(s.sent.length, n);
});

test('feed: a lost line comes back by itself with everything it was listening to, and forgets its marks', async () => {
  const { feed } = make();
  feed.watch([1, 15]); const s = Socket.all[0]; s.open(); s.mark(1, 5);
  assert.equal(feed.marks.size, 1);
  s.close();
  assert.equal(feed.marks.size, 0); assert.equal(feed.live(), false);
  await tick(1_100);
  assert.equal(Socket.all.length, 2);
  Socket.all[1].open();
  assert.equal(Socket.all[1].sent.length, 2);
  s.mark?.(1, 9); // a word from the old line
  assert.equal(feed.marks.size, 0);
  feed.stop(); await tick(5);
  assert.equal(Socket.all.length, 2, 'stopped for good');
});

test('feed: a market that does not speak is not being watched, whatever the others say', () => {
  let t = 0;
  const { feed } = make({ now: () => t });
  feed.watch([1, 15]); const s = Socket.all[0]; s.open();
  assert.equal(feed.fresh(1), false, 'not a word yet');
  s.mark(1, 5); s.mark(15, 5);
  t = 59_000; s.mark(1, 6);
  t = 61_000;
  assert.deepEqual([feed.fresh(1), feed.fresh(15), feed.fresh(undefined)], [true, false, false]);
  s.close(); assert.equal(feed.fresh(1), false);
  feed.stop();
});

test('feed: no url or no WebSocket is no feed, not an error', () => {
  for (const over of [{ url: '' }, { WebSocketImpl: undefined, url: '' }]) { const { feed } = make(over); feed.watch([1]); assert.equal(feed.live(), false); feed.stop(); }
});

const entry = (key, marketId = 1, due = 100) => ({ key, marketId, due });
const urgentAt = () => { const c = { t: 0 }; return { c, u: createUrgent({ isDue: (e, mark) => mark >= e.due, now: () => c.t }) }; };

test('urgent: first come first served, once each', () => {
  const { u } = urgentAt();
  u.load([entry('a'), entry('b', 1, 90), entry('c', 2)]);
  u.onMark(1, 95); u.onMark(1, 101); u.onMark(1, 102);
  assert.equal(u.size(), 2);
  assert.deepEqual([u.take().key, u.take().key, u.take()], ['b', 'a', null]);
});

test('urgent: nothing to do waits longer each time, acting a moment, and a bad spell is forgotten', () => {
  const { c, u } = urgentAt();
  u.load([entry('a')]);
  const times = [];
  for (let i = 0; i < 400; i++) { c.t += 1_000; u.onMark(1, 200); if (u.take()) { times.push(c.t / 1000); u.served('a', { acted: false, went: true }); } }
  assert.deepEqual(times.slice(0, 5), [1, 6, 16, 36, 76]);
  assert.ok(times.at(-1) - times.at(-2) <= 121);
  u.served('a', { acted: true, went: true }); u.onMark(1, 200);
  assert.equal(u.size(), 0, 'the venue\'s reads may still be the ones from before');
  c.t += 2_000; u.onMark(1, 200); assert.equal(u.size(), 1); u.take();
  u.served('a', { acted: false, went: true }); c.t += 5_000; u.onMark(1, 200); assert.equal(u.size(), 1, 'the spell before acting does not count'); u.take();
  // somebody else was on it: asked again in a moment, and it does not count as nothing to do
  for (let i = 0; i < 6; i++) { u.served('a', { acted: false, went: false }); c.t += 2_000; u.onMark(1, 200); assert.ok(u.take(), String(i)); }
  for (let i = 0; i < 6; i++) u.served('a', { acted: false, went: true });
  c.t += 24 * 3_600_000; u.onMark(1, 200); u.take(); u.served('a', { acted: false, went: true });
  c.t += 5_000; u.onMark(1, 200); assert.equal(u.size(), 1, 'a day later it starts from the beginning');
});

test('urgent: a venue that is busy is asked less and less, up to a point, and starts over once it answers', () => {
  const { c, u } = urgentAt();
  u.load([entry('a')]);
  const waits = [];
  for (let i = 0; i < 6; i++) {
    u.onMark(1, 200); assert.ok(u.take()); u.served('a', { acted: false, went: true, again: true });
    const from = c.t;
    while (u.size() === 0) { c.t += 1_000; u.onMark(1, 200); }
    waits.push((c.t - from) / 1000);
  }
  assert.deepEqual(waits, [2, 4, 8, 15, 15, 15]);
  u.take(); u.served('a', { acted: true, went: true });
  c.t += 2_000; u.onMark(1, 200); u.take(); u.served('a', { acted: false, went: true, again: true });
  c.t += 2_000; u.onMark(1, 200); assert.equal(u.size(), 1);
});

test('urgent: a new round replaces the state, and forgets who is gone', () => {
  const { u } = urgentAt();
  u.load([entry('a'), entry('b')]); u.onMark(1, 200);
  const fresh = entry('a');
  u.load([fresh]);
  assert.equal(u.size(), 1); assert.equal(u.take(), fresh);
});

test('urgent: several lanes wait, each arrival wakes one', async () => {
  const { u } = urgentAt();
  u.load([entry('a'), entry('b')]);
  const woke = [];
  const lanes = [1, 2, 3].map((n) => u.wait(60).then(() => { const e = u.take(); if (e) woke.push(e.key); }));
  u.onMark(1, 200);
  await Promise.all(lanes);
  assert.deepEqual(woke.sort(), ['a', 'b']);
});

test('urgent: wait wakes at once, or times out', async () => {
  const { u } = urgentAt();
  u.load([entry('a')]);
  const t = Date.now();
  setTimeout(() => u.onMark(1, 200), 20);
  await u.wait(5_000);
  assert.ok(Date.now() - t < 1_000); u.take();
  await u.wait(15); assert.equal(u.size(), 0);
});

test('hasMature: the take-profit\'s own rule, and never while something has the token already', () => {
  const coin = { token: '0x' + 'ab'.repeat(20), side: 'long', leverage: 20, takeProfitPct: 50, managed: true, market: 'NVDA' };
  const st = (over) => ({ perpTranches: [{ base: 6866, entryMark: 141.92, sizeDec: 4, ts: Date.now(), leverage: 20 }], lighterLeverage: 20, perpEngine: { market: 'NVDA', side: 'long' }, ...over });
  // live, 25 Nov 2026: target 145.468
  assert.equal(hasMature(coin, st(), 145.46), false);
  assert.equal(hasMature(coin, st(), 145.47), true);
  assert.equal(hasMature({ ...coin, side: 'short' }, st({ perpEngine: { market: 'NVDA', side: 'short' } }), 138), true);
  for (const over of [{ perpOrder: { id: 1 } }, { perpSwitch: {} }, { perpWithdrawIntentUsd: 5 }, { perpTranches: [] }, { perpTranches: undefined }, { perpEngine: { market: 'BTC', side: 'long' } }]) assert.equal(hasMature(coin, st(over), 200), false);
  assert.equal(hasMature(coin, undefined, 200), false);
  config.RETIRED.add(coin.token); assert.equal(hasMature(coin, st(), 200), false); config.RETIRED.delete(coin.token);
});
