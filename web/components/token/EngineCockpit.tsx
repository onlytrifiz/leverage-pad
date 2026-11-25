"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "cn";
import type { CoinDetail } from "@/lib/types";
import { fmtMark, fmtSignedUsd, fmtUsd } from "@/lib/format";
import { fmtNotice } from "@/lib/doppler";
import { engineDiff } from "@/lib/engine";
import { COLLATERAL_HEADROOM, FIRST_OPEN_DELAY_MIN, OPENS_AT_USD, OPEN_LEAST_USD, fmtThreshold } from "@/lib/thresholds";
import { useLiveMark, useLivePositions } from "@/hooks/use-lighter-live";
import AssetIcon from "@/components/AssetIcon";
import { LivePulse } from "@/components/motion";

/**
 * The engine, as an instrument rather than a table of eight numbers.
 *
 * Live data comes the way HedgeCard always took it: the account channel says
 * what the position is, the market channel what it is worth now, and P&L is
 * recomputed from the fresh mark (sign × (mark − entry) × size), the venue's own
 * formula. What changes is how it reads:
 *
 *   the rail   liquidation, entry, now and the next take-profit on one line,
 *              price rising left to right; the marker for "now" travels live
 *   the P&L    one large figure that flashes when it moves
 *   the ring   before the position opens, how far the fees are from the gate
 */


export default function EngineCockpit({ detail }: { detail: CoinDetail }) {
  const reduced = useReducedMotion();
  const { coin, perp, stats, tranches, managedDelayS } = detail;
  // during a switch the open position is still the previous engine's
  const runs = detail.engineSwitch?.from ?? coin;
  const all = useLivePositions(perp?.accountIndex);
  const live = perp?.marketId != null ? (all?.[perp.marketId] ?? null) : null;
  const open = all != null ? !!live : !!perp?.open;

  const size = live?.size ?? null;
  const entry = live?.entryPrice ?? perp?.entryPrice ?? null;
  const mark = useLiveMark(perp?.marketId) ?? perp?.markPrice ?? null;
  const sign = live?.sign ?? (runs.side === "short" ? -1 : 1);
  const pnl =
    mark != null && size && entry != null
      ? sign * (mark - entry) * size
      : (live?.unrealizedPnlUsd ?? perp?.unrealizedPnlUsd ?? null);
  const collateral = live?.allocatedMarginUsd ?? perp?.collateralUsd ?? null;
  const notional = mark != null && size ? mark * size : (live?.positionValueUsd ?? perp?.positionSizeUsd ?? null);
  const liq = live?.liquidationPrice ?? perp?.liquidationPrice ?? null;
  const funding = live?.fundingPaidUsd ?? perp?.fundingPaidUsd ?? null;

  const trigger = coin.takeProfitPct / 100;
  const isShort = runs.side === "short";
  // the nearest target: tranches arrive sorted by progress, the first is closest to banking
  const target =
    tranches[0]?.targetMark ??
    (entry != null ? entry * (1 + (isShort ? -1 : 1) * (trigger / coin.leverage)) : null);

  // closed, with collateral in the account that no take-profit took out (a change of engine, an order that has not filled)
  const idle = stats.idleUsd * COLLATERAL_HEADROOM;
  // the stream saw it close before the page did: read what it left
  const justClosed = !open && !!perp?.open;
  const gate = OPENS_AT_USD;
  const opening = !open && !detail.engineBlocked && idle >= OPEN_LEAST_USD;
  const router = useRouter();
  useEffect(() => {
    if (justClosed) router.refresh();
  }, [justClosed, router]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <AssetIcon symbol={coin.market} size={22} />
        <h2 className="font-display text-xl font-semibold">The engine</h2>
        <span className="text-sm text-ink-3">
          {coin.market} {coin.leverage}x {coin.side}, take-profit +{coin.takeProfitPct}%
        </span>
        {coin.managed && (
          <span
            className="rounded-full border border-brand/40 px-2 py-0.5 text-2xs font-semibold tracking-wide text-brand uppercase"
            title={`Its creator can change market, side, leverage and take-profit, ${managedDelayS > 0 ? `each change announced ${fmtNotice(managedDelayS)} ahead` : "each change announced on-chain"}`}
          >
            Managed
          </span>
        )}
      </div>
      <span className={cn("flex items-center gap-1.5 text-xs font-medium", open ? "text-brand" : "text-ink-3")}>
        {open && <LivePulse tone="brand" />}
        {open ? "Live on Lighter" : opening ? "Opening" : "Accumulating fees"}
      </span>
    </div>
  );

  const notices = <EngineNotices detail={detail} />;

  if (!open) {
    const reserve = stats.waitingUsd + stats.idleUsd;
    const pct = opening ? 1 : Math.max(0, Math.min(1, reserve / gate));
    const R = 54;
    const C = 2 * Math.PI * R;
    return (
      <section className="overflow-hidden rounded-[18px] border border-line bg-panel">
        {header}
        {notices}
        <div className="grid grid-cols-1 items-center gap-6 p-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-8 sm:p-6">
          <div className="relative mx-auto size-[140px]">
            <svg viewBox="0 0 140 140" className="size-full -rotate-90">
              <circle cx="70" cy="70" r={R} fill="none" stroke="var(--color-panel-2)" strokeWidth="10" />
              <motion.circle
                cx="70"
                cy="70"
                r={R}
                fill="none"
                stroke="var(--color-brand)"
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={C}
                initial={{ strokeDashoffset: C }}
                animate={{ strokeDashoffset: C * (1 - pct) }}
                transition={{ duration: reduced ? 0 : 1.4, ease: [0.16, 1, 0.3, 1] }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="num text-2xl font-semibold text-ink">{Math.round(pct * 100)}%</span>
              <span className="text-2xs text-ink-3">{opening ? "funded" : "to the gate"}</span>
            </div>
          </div>
          <div className="min-w-0">
            <p className="font-display text-2xl leading-tight font-semibold text-ink">
              {justClosed ? "Position closed." : opening ? `Opening with ${fmtUsd(idle)}.` : `${fmtUsd(reserve)} of ${fmtThreshold(gate)} collected.`}
            </p>
            <p className="mt-2 max-w-[52ch] text-base leading-relaxed text-ink-2">
              {opening ? (
                <>
                  {coin.market}, {coin.side}, {coin.leverage}x, as soon as the market fills the order.
                </>
              ) : (
                <>
                  The position opens on Lighter as soon as the token&apos;s fees reach the gate: {coin.market}, {coin.side},{" "}
                  {coin.leverage}x. Every trade on the token brings it closer.
                  {stats.perpFundedUsd === 0 && ` The first one waits ${FIRST_OPEN_DELAY_MIN} minutes from the launch, so the opening fees go in together.`}
                  {stats.buybackWaitingUsd >= 0.01 && (
                    <>
                      {" "}
                      <span className="num text-ink">{fmtUsd(stats.buybackWaitingUsd)}</span> from its last take-profit is on its way to a
                      buyback.
                    </>
                  )}
                </>
              )}
            </p>
          </div>
        </div>
      </section>
    );
  }

  /* the rail: price rising left to right, danger on the liquidation side */
  const lo = isShort ? target : liq;
  const hi = isShort ? liq : target;
  const span = lo != null && hi != null && hi > lo ? hi - lo : null;
  const at = (p: number | null) => (p == null || span == null || lo == null ? null : Math.max(0, Math.min(100, ((p - lo) / span) * 100)));
  const nowPct = at(mark);
  const entryPct = at(entry);
  const pnlPct = pnl != null && collateral ? (pnl / collateral) * 100 : null;
  const toTarget = mark != null && target != null ? ((target - mark) / mark) * 100 : null;
  const reached = toTarget != null && (isShort ? toTarget >= 0 : toTarget <= 0);
  const toLiq = mark != null && liq != null ? (Math.abs(mark - liq) / mark) * 100 : null;
  const tone = pnl == null ? "text-ink" : pnl >= 0 ? "text-up" : "text-down";

  return (
    <section className="overflow-hidden rounded-[18px] border border-line bg-panel">
      {header}
      {notices}
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div>
            <div className="text-xs text-ink-3">Unrealized P&amp;L</div>
            <motion.div
              key={pnl == null ? "none" : Math.round(pnl * 100)}
              initial={reduced ? false : { backgroundColor: pnl != null && pnl >= 0 ? "rgba(15,122,67,0.14)" : "rgba(179,38,30,0.12)" }}
              animate={{ backgroundColor: "rgba(0,0,0,0)" }}
              transition={{ duration: 0.9 }}
              className={cn("num -mx-1.5 mt-1 rounded-md px-1.5 text-5xl leading-none font-semibold tracking-[-0.02em]", tone)}
            >
              {fmtSignedUsd(pnl)}
            </motion.div>
            {pnlPct != null && (
              <div className={cn("num mt-2 text-sm", tone)}>
                {pnlPct >= 0 ? "+" : ""}
                {pnlPct.toFixed(1)}% on {fmtUsd(collateral)} collateral
              </div>
            )}
          </div>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-3 text-right">
            <div>
              <dt className="text-2xs text-ink-3">Position</dt>
              <dd className="num text-base font-semibold text-ink">{fmtUsd(notional)}</dd>
            </div>
            <div>
              <dt className="text-2xs text-ink-3">To take-profit</dt>
              <dd className="num text-base font-semibold text-brand">
                {toTarget == null ? "—" : reached ? "Reached" : `${toTarget >= 0 ? "+" : ""}${toTarget.toFixed(2)}%`}
              </dd>
            </div>
            <div>
              <dt className="text-2xs text-ink-3">Funding</dt>
              <dd className={cn("num text-base font-semibold", funding == null ? "text-ink" : funding >= 0 ? "text-up" : "text-down")}>
                {fmtSignedUsd(funding)}
              </dd>
            </div>
          </dl>
        </div>

        {/* the rail */}
        {span != null && (
          <div className="mt-10 mb-2">
            <div className="relative h-2.5 rounded-full engine-rail" data-short={isShort || undefined}>
              {entryPct != null && (
                <span className="absolute top-1/2 h-5 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-ink/60" style={{ left: `${entryPct}%` }} />
              )}
              {nowPct != null && (
                <motion.div
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                  initial={false}
                  animate={{ left: `${nowPct}%` }}
                  transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 140, damping: 22 }}
                >
                  {/* slides from its left edge to its right one along the rail, so it never leaves the card */}
                  <span
                    style={{ transform: `translateX(-${nowPct}%)` }}
                    className="absolute bottom-[calc(100%+10px)] left-1/2 rounded-md bg-ink px-2 py-1 text-2xs font-semibold whitespace-nowrap text-white"
                  >
                    now <span className="num">{fmtMark(mark)}</span>
                  </span>
                  <span className="relative flex size-4">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-ink/30 motion-reduce:hidden" />
                    <span className="relative inline-flex size-4 rounded-full border-[3px] border-panel bg-ink shadow" />
                  </span>
                </motion.div>
              )}
            </div>
            <div className="relative mt-3 flex justify-between text-2xs text-ink-3">
              <span className="text-left">
                {isShort ? "Take profit" : "Liquidation"}
                <span className="num block text-sm text-ink">{fmtMark(lo)}</span>
              </span>
              {/* under its own mark, as far as the two ends leave it room */}
              <span className="absolute top-0 -translate-x-1/2 text-center" style={{ left: `clamp(30%, ${entryPct ?? 50}%, 70%)` }}>
                Entry
                <span className="num block text-sm text-ink">{fmtMark(entry)}</span>
              </span>
              <span className="text-right">
                {isShort ? "Liquidation" : "Take profit"}
                <span className="num block text-sm text-ink">{fmtMark(hi)}</span>
              </span>
            </div>
            {toLiq != null && (
              <p className="mt-4 text-xs text-ink-3">
                Liquidation is <span className="num text-ink">{toLiq.toFixed(1)}%</span> away. If it comes, the
                position loses its collateral and nothing else: the pool and every holder&apos;s balance stay as they are.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * What a holder must know before reading the numbers: the keeper paused the engine (the venue
 * refuses this leverage on this market), or the creator of a managed coin has announced a
 * change that lands at a known time.
 */
function EngineNotices({ detail }: { detail: CoinDetail }) {
  const { coin, engineBlocked, engineSwitch } = detail;
  const p = coin.pendingEngine;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!p) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, [p]);
  if (!engineBlocked && !engineSwitch && !p) return null;
  const left = p ? Math.max(0, p.effectiveAt - now) : 0;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return (
    <div className="space-y-px border-b border-line">
      {engineBlocked && (
        <p className="bg-[color-mix(in_oklch,var(--color-down),transparent_90%)] px-5 py-3 text-sm text-ink">
          <span className="font-semibold text-down">Engine paused.</span> {engineBlocked}. Fees keep accumulating; the
          position opens once the engine fits the venue.
        </p>
      )}
      {engineSwitch && (
        <p className="bg-panel-2 px-5 py-3 text-sm text-ink">
          <span className="font-semibold">Switching.</span> The {engineSwitch.from.market} {engineSwitch.from.side} closes first,
          then the engine opens {coin.market} {coin.side}. A closed market or an empty book can make it wait.
        </p>
      )}
      {p && (
        <p className="bg-brand-soft px-5 py-3 text-sm text-ink">
          <span className="font-semibold text-brand">Change announced by the creator</span>: {engineDiff(coin, p)},{" "}
          {left > 0 ? (
            <>
              in effect in <span className="num font-semibold">{h}h {m}m</span>.
            </>
          ) : (
            "in effect now."
          )}
        </p>
      )}
    </div>
  );
}
