const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');

/**
 * lighter/rest.js: Lighter's public reads, from Node.
 *
 * Only signing needs the Python SDK. A read through the sidecar costs a second of Python starting
 * up; here it is one request on a connection already open. The answers have the sidecar's shape,
 * so whoever calls does not know the difference.
 *
 * A request that carries an account's token counts on that account's 60 a minute; without one, all
 * of them share 60 per IP, of which 40 may be trades. The queues keep under both; what runs inside
 * `urgently` goes first. A token the venue will not have is dropped and the read goes without it.
 */
const HOST = config.LIGHTER_REST_URL;
const lane = new AsyncLocalStorage();
const urgently = (fn) => lane.run({ urgent: true }, fn);
const isUrgent = () => !!lane.getStore()?.urgent;

/** at most `perMinute` starts in any rolling minute, urgent ones first, then in order */
function createLimiter({ perMinute, now = Date.now, setTimer = setTimeout }) {
  const started = [], front = [], back = [];
  let timer = null, pausedUntil = 0;
  function pump() {
    timer = null;
    for (;;) {
      if (!front.length && !back.length) return;
      const t = now();
      while (started.length && t - started[0] >= 60_000) started.shift();
      const wait = Math.max(pausedUntil - t, started.length >= perMinute ? started[0] + 60_000 - t : 0);
      if (wait > 0) { timer = setTimer(pump, wait); return; }
      started.push(t);
      (front.shift() || back.shift())();
    }
  }
  return {
    slot() {
      return new Promise((res) => {
        (isUrgent() ? front : back).push(res);
        if (!timer) pump();
        else if (pausedUntil <= now()) { clearTimeout(timer); timer = null; pump(); }
      });
    },
    /** the venue said too many: nobody asks for a while */
    pause(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); },
    /** requests made by others on the same allowance */
    charge(n) { const t = now(); for (let i = 0; i < n; i++) started.push(t); },
    spare() { const t = now(); return Math.max(0, perMinute - started.filter((s) => t - s < 60_000).length - front.length - back.length); },
    waiting: () => front.length + back.length,
  };
}

const reads = createLimiter({ perMinute: config.LIGHTER_READS_PER_MIN });
const trades = createLimiter({ perMinute: config.LIGHTER_TRADES_PER_MIN });

const perAccount = new Map(); // account → its own queues
const queuesOf = (id) => {
  if (!perAccount.has(id)) perAccount.set(id, { reads: createLimiter({ perMinute: config.LIGHTER_READS_PER_MIN }), trades: createLimiter({ perMinute: config.LIGHTER_TRADES_PER_MIN }) });
  return perAccount.get(id);
};
let tokenOf = () => null;          // account → its token now, or null (never waits)
const barred = new Map();          // account → until when its token is not used
const barredUntil = (id) => barred.get(id) || 0;
const tokenFor = (id) => (id == null || Date.now() < barredUntil(id) ? null : tokenOf(id));

async function get(path, params, { isTrades = false, as = null } = {}) {
  const id = as == null ? null : Number(as), token = tokenFor(id);
  const q = token ? queuesOf(id) : { reads, trades };
  if (isTrades) await q.trades.slot();
  await q.reads.slot();
  const url = `${HOST}${path}?${new URLSearchParams(params)}`;
  let res, body;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'node', ...(token ? { authorization: token } : {}) }, signal: AbortSignal.timeout(config.LIGHTER_READ_TIMEOUT_MS) });
    // before the body: a 429 does not always come with one that can be read
    if (res.status === 429) { q.reads.pause(15_000); q.trades.pause(15_000); }
    if (token && (res.status === 401 || res.status === 403)) {
      barred.set(id, Date.now() + 10 * 60_000);
      return get(path, params, { isTrades, as });
    }
    body = await res.json();
  } catch (e) {
    throw new Error(`lighter:${path}: ${e.name === 'TimeoutError' ? 'timeout' : `${res ? `${res.status} ` : ''}${e.message}`}`);
  }
  if (!res.ok || (body.code != null && Number(body.code) !== 200)) {
    const e = new Error(`lighter:${path}: ${res.status} ${body.message || ''}`.trim());
    e.venue = body.message || '';
    throw e;
  }
  return body;
}

async function account({ accountIndex }) {
  const a = (await get('/api/v1/account', { by: 'index', value: accountIndex }, { as: accountIndex })).accounts?.[0];
  // an answer about another account, or about none, is not an empty account
  if (!a || Number(a.index ?? a.account_index) !== Number(accountIndex)) throw new Error(`lighter:account: no account ${accountIndex} in the answer`);
  if (!Array.isArray(a.positions) || a.collateral == null) throw new Error('lighter:account: incomplete answer');
  return {
    ok: true,
    collateral: a.collateral,
    available_balance: a.available_balance,
    positions: a.positions.map((p) => ({
      market_id: p.market_id,
      sign: p.sign,
      size: p.position,
      avg_entry_price: p.avg_entry_price,
      unrealized_pnl: p.unrealized_pnl,
      allocated_margin: p.allocated_margin,
      liquidation_price: p.liquidation_price,
      total_funding_paid_out: p.total_funding_paid_out ?? null,
    })),
    raw: a,
  };
}

/** what one order traded, found by its client order index, across pages newest first */
async function fills({ accountIndex, marketIndex, clientOrderIndex, since = 0 }) {
  const me = Number(accountIndex), cid = Number(clientOrderIndex);
  let size = 0, quote = 0, cursor;
  for (let page = 0; page < 10; page++) {
    const r = await get('/api/v1/trades', { sort_by: 'timestamp', limit: 100, account_index: me, market_id: marketIndex, ...(cursor ? { cursor } : {}) }, { isTrades: true, as: me });
    if (!Array.isArray(r.trades)) throw new Error('lighter:trades: incomplete answer');
    for (const t of r.trades) {
      const mine = (Number(t.ask_account_id) === me && Number(t.ask_client_id) === cid) || (Number(t.bid_account_id) === me && Number(t.bid_client_id) === cid);
      if (!mine) continue;
      size += Number(t.size);
      quote += Number(t.size) * Number(t.price);
    }
    cursor = r.next_cursor;
    if (!cursor || !r.trades.length || Number(r.trades.at(-1).timestamp) < since - 60_000) break;
  }
  return { ok: true, size, price: size > 0 ? quote / size : null };
}

/** 0 failed, 1 pending, 2 and 3 executed; null: the venue has never seen it */
async function tx({ hash, accountIndex = null }) {
  try { return { status: Number((await get('/api/v1/tx', { by: 'hash', value: hash }, { as: accountIndex })).status) }; }
  catch (e) { if (/transaction not found/i.test(e.venue || '')) return null; throw e; }
}

async function resolveAccount({ address }) {
  let r;
  try { r = await get('/api/v1/accountsByL1Address', { l1_address: address }); }
  catch (e) { if (/account not found/i.test(e.venue || '')) return { ok: true, accountIndex: null }; throw e; }
  const subs = (r.sub_accounts || []).map((s) => Number(s.index));
  return { ok: true, accountIndex: subs.length ? Math.min(...subs) : null, subAccounts: subs };
}

async function markets() {
  const books = (await get('/api/v1/orderBooks', {})).order_books;
  if (!Array.isArray(books) || !books.length) throw new Error('lighter:orderBooks: incomplete answer');
  const out = {};
  for (const m of books) out[m.symbol] = { index: m.market_id, size_dec: m.supported_size_decimals, price_dec: m.supported_price_decimals, min_base: m.min_base_amount, min_quote: m.min_quote_amount, status: m.status };
  // the leverage caps: without them the markets still come back, with no cap to check against
  try {
    for (const b of (await get('/api/v1/orderBookDetails', {})).order_book_details || []) {
      const imf = Number(b.min_initial_margin_fraction);
      if (out[b.symbol] && imf > 0) out[b.symbol].min_imf = imf;
    }
  } catch { /* next refresh */ }
  return { ok: true, markets: out };
}

module.exports = {
  account, fills, tx, resolveAccount, markets, urgently, isUrgent, createLimiter, spareReads: () => reads.spare(),
  /** `fn(account)`: the token to read it with, now, or null */
  useTokens(fn) { tokenOf = fn; },
  authed: (id) => tokenFor(id == null ? null : Number(id)) != null,
  /** requests the sidecar makes for an account: on its token when it has one */
  charge(n, id) { (id != null && tokenFor(Number(id)) ? queuesOf(Number(id)).reads : reads).charge(n); },
};
