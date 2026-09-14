/**
 * Engine thresholds — one definition for server and browser.
 *
 * The keeper's gates were written as literals in the pages ("Opens at $20"), so
 * during the low-threshold tests the site announced a gate that did not exist.
 * `lib/config.ts` fixed that for server components; the sidebars and the swap
 * panel are client components and could not read the server var, so they kept
 * their own literals. Now both read this file: `NEXT_PUBLIC_*` is what reaches
 * the browser, the server var is the fallback when only it is set.
 */
const n = (...candidates: (string | undefined)[]) => {
  for (const c of candidates) {
    const parsed = Number(c);
    if (c != null && c !== "" && Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

export const fmtThreshold = (v: number) =>
  Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;

export const OPEN_GATE_USD =
  n(process.env.NEXT_PUBLIC_OPEN_GATE_USD, process.env.PERPSPAD_OPEN_GATE_USD) ?? 20;
export const TOPUP_STEP_USD =
  n(process.env.NEXT_PUBLIC_TOPUP_STEP_USD, process.env.PERPSPAD_TOPUP_STEP_USD) ?? 20;
export const BUYBACK_FLOOR_USD =
  n(process.env.NEXT_PUBLIC_BUYBACK_FLOOR_USD, process.env.PERPSPAD_BUYBACK_FLOOR_USD) ?? 25;
export const CREATOR_MIN_PAYOUT_USD = 1;

export const OPEN_GATE_LABEL = fmtThreshold(OPEN_GATE_USD);
export const BUYBACK_FLOOR_LABEL = fmtThreshold(BUYBACK_FLOOR_USD);
export const CREATOR_MIN_PAYOUT_LABEL = fmtThreshold(CREATOR_MIN_PAYOUT_USD);
