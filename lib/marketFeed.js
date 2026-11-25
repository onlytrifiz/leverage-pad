/**
 * Live marks from Lighter's public stream, and the tokens they make urgent.
 *
 * The keeper goes over its tokens one after the other, and a full round grows with their number: a
 * target touched for a minute could be missed. Here the marks of every market in use arrive about
 * once a second, and a token with a tranche at its target is put in front of the others.
 *
 * It is an alarm and nothing more. What to close, and whether to, is decided where it always was,
 * on the account read at that moment: a wrong or late mark costs one useless read. Without the
 * stream the keeper does exactly what it did before it existed.
 */
const BACKOFF_MS = [1_000, 3_000, 6_000, 10_000, 15_000];
const QUIET_MS = 20_000; // a market speaks every second: this long without a word is a dead line

function createFeed({ url, onMark, WebSocketImpl = globalThis.WebSocket, log = console.log, now = Date.now }) {
  let ws = null, wanted = new Set(), subscribed = new Set(), retry = 0, timer = null, heard = 0, stopped = !url || !WebSocketImpl, said = null;
  const marks = new Map();
  const say = (msg) => { if (said !== msg) { said = msg; log(`  [feed] ${msg}`); } };
  const send = (type, id) => { try { ws.send(JSON.stringify({ type, channel: `market_stats/${id}` })); } catch { /* the line is going down: it is all sent again */ } };

  function sync() {
    if (!ws || ws.readyState !== 1) return;
    for (const id of wanted) if (!subscribed.has(id)) { send('subscribe', id); subscribed.add(id); }
    for (const id of subscribed) if (!wanted.has(id)) { send('unsubscribe', id); subscribed.delete(id); marks.delete(id); }
  }

  function connect() {
    if (stopped || ws || !wanted.size) return;
    let mine;
    try { mine = new WebSocketImpl(url); } catch (e) { say(`not reachable (${String(e.message).slice(0, 60)})`); return later(); }
    ws = mine; subscribed = new Set(); heard = now();
    mine.onopen = () => { if (ws === mine) { sync(); say('live'); } };
    mine.onmessage = (ev) => {
      if (ws !== mine) return;
      heard = now(); retry = 0;
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'ping') { try { mine.send('{"type":"pong"}'); } catch { /* it will close */ } return; }
      if (!/market_stats/.test(String(m.type)) || !m.market_stats) return;
      const id = Number(m.market_stats.market_id), mark = Number(m.market_stats.mark_price);
      if (!Number.isFinite(id) || !(mark > 0) || !wanted.has(id)) return;
      marks.set(id, { mark, at: now() });
      try { onMark(id, mark); } catch (e) { say(`mark not handled (${String(e.message).slice(0, 80)})`); }
    };
    mine.onclose = () => drop(mine);
    mine.onerror = () => drop(mine);
  }

  function drop(which) {
    if (ws !== which) return;
    ws = null; marks.clear();
    try { which.close(); } catch { /* already */ }
    if (!stopped && wanted.size) say('lost, connecting again');
    later();
  }
  function later() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; connect(); }, BACKOFF_MS[Math.min(retry++, BACKOFF_MS.length - 1)]);
    if (timer.unref) timer.unref();
  }
  const guard = setInterval(() => { if (ws && now() - heard > QUIET_MS) drop(ws); }, 5_000);
  if (guard.unref) guard.unref();

  return {
    /** the markets to listen to, from now on */
    watch(ids) { wanted = new Set([...ids].map(Number).filter(Number.isFinite)); if (!ws && !timer) connect(); else sync(); },
    marks,
    live: () => !!ws && ws.readyState === 1,
    stop() { stopped = true; clearInterval(guard); clearTimeout(timer); const w = ws; ws = null; try { w && w.close(); } catch { /* gone */ } },
  };
}

const COOL_MIN_MS = 5_000, COOL_MAX_MS = 120_000;

/**
 * The tokens waiting in front. `isDue(entry, mark)` says whether a token has something to do at
 * that mark; one that was served and had nothing to do waits longer each time (a leftover too small
 * to close is at its target forever), one that acted may come back at once.
 */
function createUrgent({ isDue, now = Date.now }) {
  let byMarket = new Map(), queue = new Map(), cool = new Map(), wake = null;
  return {
    /** entries: [{ key, marketId, ... }], replaced at every round of the keeper */
    load(entries) {
      byMarket = new Map();
      for (const e of entries) byMarket.set(e.marketId, [...(byMarket.get(e.marketId) || []), e]);
      const alive = new Set(entries.map((e) => e.key));
      for (const k of queue.keys()) if (!alive.has(k)) queue.delete(k);
      for (const e of entries) if (queue.has(e.key)) queue.set(e.key, e); // the same token, the new round's state
    },
    onMark(marketId, mark) {
      for (const e of byMarket.get(marketId) || []) {
        if (queue.has(e.key) || now() < (cool.get(e.key)?.until ?? 0) || !isDue(e, mark)) continue;
        queue.set(e.key, e);
        if (wake) wake();
      }
    },
    /** the one that has waited longest, or null */
    take() {
      const first = queue.entries().next().value;
      if (!first) return null;
      queue.delete(first[0]);
      return first[1];
    },
    served(key, acted) {
      const ms = acted ? COOL_MIN_MS : Math.min(COOL_MAX_MS, (cool.get(key)?.ms ?? COOL_MIN_MS / 2) * 2);
      cool.set(key, { ms, until: now() + (acted ? 0 : ms) });
    },
    size: () => queue.size,
    /** until somebody is waiting, or `ms` */
    async wait(ms) {
      if (queue.size) return;
      await new Promise((res) => {
        const t = setTimeout(done, ms);
        function done() { clearTimeout(t); wake = null; res(); }
        wake = done;
      });
    },
  };
}

module.exports = { createFeed, createUrgent };
