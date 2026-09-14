/**
 * Shared client/server formatting. No dependencies.
 *
 * The em dash returned for a missing value is deliberate and is the only one
 * left on the site: in a column of figures it is the conventional glyph for
 * "no value", and "n/a" in its place would read as an error rather than a gap.
 */

export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "—";
  if (Math.abs(v) >= 1000)
    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  if (v === 0) return "$0";
  if (v >= 1) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return "$" + v.toPrecision(4).replace(/e-?\d+$/, (m) => m); // sotto $1: 4 cifre significative
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-US");
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return (v * 100).toFixed(2) + "%";
}

export function shortAddr(a: string): string {
  return a.slice(0, 6) + "…" + a.slice(-4);
}

export function timeAgo(tsSec: number, nowSec?: number): string {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const d = Math.max(0, now - tsSec);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/**
 * Perp mark price. The same four-line ternary was inlined in the ticker, the
 * markets rail, the launch preview and the launch grid, and had already drifted
 * between them (4 significant digits in one place, 5 in another).
 */
export function fmtMark(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  if (v >= 100) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return "$" + v.toPrecision(4);
}

/** Signed percentage, sign first: the sign carries the meaning, colour repeats it. */
export function fmtChange(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}

/** Signed dollar amount, e.g. "+$1,204" / "−$83.40". */
export function fmtSignedUsd(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return (v >= 0 ? "+" : "−") + fmtUsd(Math.abs(v));
}
