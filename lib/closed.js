/**
 * closed.js — the tranches that are over, for the site to show.
 *
 * The book of open tranches forgets a tranche the moment it closes. This keeps what became of it:
 * when it opened and closed, at what prices, what it put in and what it made or lost, and how it
 * ended (`tp`, `liquidated`, `switched`, `retired`). Accounting never reads it: it is history only.
 *
 * A tranche closed in several fills (a take-profit taken in halves, a liquidation in steps) is one
 * record, grown at each fill. The newest MAX_CLOSED are kept.
 */
const MAX_CLOSED = 100;

/** of `tranches` (oldest first), the parts `closedBase` units close: [{ t, base }] */
function partsOf(tranches, closedBase) {
  let left = Math.max(0, Math.round(closedBase));
  const parts = [];
  for (const t of tranches) {
    if (left <= 0) break;
    const base = Math.min(t.base, left);
    if (base > 0) parts.push({ t, base });
    left -= base;
  }
  return parts;
}

/** what the tranches lost from `before` to `after` (same order, by open time): [{ t, base }] */
function shrunk(before, after) {
  const left = new Map(after.map((t) => [`${t.ts}|${t.entryMark}`, t.base]));
  return before
    .map((t) => ({ t, base: t.base - (left.get(`${t.ts}|${t.entryMark}`) ?? 0) }))
    .filter((p) => p.base > 0);
}

/**
 * The records for `parts` closed at `exit` (null when the venue closed them at a price we did not
 * see). `pnlUsd`, when known, is the result of the whole close: shared by each part's price gain,
 * or by size when the prices say nothing. A liquidation loses each part's collateral.
 */
function recordsOf(parts, { outcome, exit = null, at = Date.now(), side, market, leverage, pnlUsd = null }) {
  const dir = side === 'short' ? -1 : 1;
  const units = (p) => p.base / 10 ** (p.t.sizeDec || 0);
  const collateral = (p) => (Number(p.t.collateralUsd) || 0) * (p.t.base > 0 ? p.base / p.t.base : 0);
  const gain = (p) => (exit == null ? 0 : dir * (exit - p.t.entryMark) * units(p));
  const gains = parts.map(gain), sum = gains.reduce((a, g) => a + g, 0);
  const size = parts.reduce((a, p) => a + p.base, 0);
  return parts.map((p, i) => {
    let pnl;
    if (outcome === 'liquidated') pnl = -collateral(p);
    else if (pnlUsd == null) pnl = gains[i];
    else if (sum !== 0 && Math.sign(sum) === Math.sign(pnlUsd)) pnl = pnlUsd * gains[i] / sum;
    else pnl = size > 0 ? pnlUsd * p.base / size : 0;
    return {
      openedAt: p.t.ts ?? null, closedAt: at, outcome, market, side,
      leverage: p.t.leverage ?? leverage ?? null,
      entry: p.t.entryMark, exit, size: units(p),
      collateralUsd: collateral(p), pnlUsd: pnl,
    };
  });
}

/** into the coin's history: a later fill of a tranche already there grows its record */
function bookClosed(st, records) {
  if (!records.length) return;
  if (!Array.isArray(st.perpClosed)) st.perpClosed = [];
  for (const r of records) {
    const same = st.perpClosed.find((c) => c.openedAt === r.openedAt && c.entry === r.entry && c.outcome === r.outcome && c.market === r.market);
    if (!same) { st.perpClosed.push(r); continue; }
    const size = same.size + r.size;
    if (same.exit != null && r.exit != null && size > 0) same.exit = (same.exit * same.size + r.exit * r.size) / size;
    else same.exit = same.exit ?? r.exit;
    same.size = size;
    same.collateralUsd += r.collateralUsd;
    same.pnlUsd += r.pnlUsd;
    same.closedAt = Math.max(same.closedAt, r.closedAt);
  }
  st.perpClosed.sort((a, b) => a.closedAt - b.closedAt);
  if (st.perpClosed.length > MAX_CLOSED) st.perpClosed.splice(0, st.perpClosed.length - MAX_CLOSED);
}

/** history never stands in the way of the books: whatever goes wrong here is only said */
function noteClosed(st, make) {
  try { bookClosed(st, make()); } catch (e) { console.log(`  closed-tranche history: ${String(e && e.message).slice(0, 100)}`); }
}

module.exports = { partsOf, shrunk, recordsOf, bookClosed, noteClosed, MAX_CLOSED };
