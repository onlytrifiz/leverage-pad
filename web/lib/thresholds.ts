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
  n(process.env.NEXT_PUBLIC_OPEN_GATE_USD, process.env.PERPSPAD_OPEN_GATE_USD) ?? 25;
export const TOPUP_STEP_USD =
  n(process.env.NEXT_PUBLIC_TOPUP_STEP_USD, process.env.PERPSPAD_TOPUP_STEP_USD) ?? 25;
/** the first position waits this long from the launch, and an open one takes one tranche per interval (config.js) */
export const FIRST_OPEN_DELAY_MIN = 10;
export const TRANCHE_INTERVAL_MIN = n(process.env.NEXT_PUBLIC_TRANCHE_INTERVAL_MIN) ?? 60;
export const fmtEvery = (min: number) => (min === 60 ? "hour" : `${min} minutes`);
/** the keeper keeps a little of the collateral back for the fill, and opens from a gate's worth of it up (config.js) */
const MIN_DEPLOY_USD = 2;
export const COLLATERAL_HEADROOM = 0.95;
export const OPEN_LEAST_USD = Math.max(MIN_DEPLOY_USD, OPEN_GATE_USD * COLLATERAL_HEADROOM * 0.9);
/** what opens a position: the gate, or the venue-side minimum when a test gate is below it */
export const OPENS_AT_USD = Math.max(OPEN_GATE_USD, MIN_DEPLOY_USD / COLLATERAL_HEADROOM);
export const BUYBACK_FLOOR_USD =
  n(process.env.NEXT_PUBLIC_BUYBACK_FLOOR_USD, process.env.PERPSPAD_BUYBACK_FLOOR_USD) ?? 20;
/** the most a single buyback spends (config.js) */
export const BUYBACK_MAX_USD = 25;
export const CREATOR_MIN_PAYOUT_USD = 1;

export const OPEN_GATE_LABEL = fmtThreshold(OPEN_GATE_USD);
export const BUYBACK_FLOOR_LABEL = fmtThreshold(BUYBACK_FLOOR_USD);
export const CREATOR_MIN_PAYOUT_LABEL = fmtThreshold(CREATOR_MIN_PAYOUT_USD);
