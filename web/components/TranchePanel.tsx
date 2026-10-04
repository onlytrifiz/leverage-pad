"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import type { CoinDetail } from "@/lib/types";
import { fmtUsd, timeAgo, fmtMark } from "@/lib/format";
import { Panel, PanelHeader, PanelTitle, PanelMeta } from "@/components/ui/panel";
import { Layers } from "@/components/animate-ui/icons/layers";
import { useLiveMark } from "@/hooks/use-lighter-live";

/**
 * The tranche ladder: every deposit the engine made runs toward its OWN target
 * (entry × trigger / leverage). The bars filling explain at a glance why the
 * take-profit has not fired yet — or how much is left.
 *
 * The bars track the live mark from Lighter's stream. Only the numbers move:
 * the rows keep the order the server sent, because a ladder that re-sorts under
 * the reader's eyes makes the one bar they were watching impossible to follow.
 */

export default function TranchePanel({ detail }: { detail: CoinDetail }) {
  const { coin, perp } = detail;
  const mark = useLiveMark(perp?.marketId);

  const tranches = useMemo(() => {
    if (mark == null) return detail.tranches;
    return detail.tranches.map((t) => {
      const span = t.targetMark - t.entryMark;
      return {
        ...t,
        progress: span !== 0 ? Math.max(0, Math.min(1, (mark - t.entryMark) / span)) : t.progress,
        movePct:
          ((coin.side === "short" ? t.entryMark - mark : mark - t.entryMark) / t.entryMark) * 100,
      };
    });
  }, [detail.tranches, mark, coin.side]);

  if (!tranches.length) return null;
  // the lowest target on the ladder: below the coin's take-profit once old deposits decay
  const trigger = Math.min(...tranches.map((t) => t.takeProfitPct));

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle className="flex items-center gap-2">
          <Layers aria-hidden size={16} animateOnView className="text-brand" />
          Tranches · take-profit ladder
        </PanelTitle>
        <PanelMeta>
          Each banks fully at +{coin.takeProfitPct}%{trigger < coin.takeProfitPct ? ", lower for old deposits" : ""}
        </PanelMeta>
      </PanelHeader>
      <div className="flex flex-col gap-1 p-2.5">
        {tranches.map((t, i) => {
          const ripe = t.progress >= 1;
          return (
            <div key={i} className={`rounded-lg px-3 py-2.5 ${ripe ? "border-l-2 border-brand bg-brand-soft" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex items-baseline gap-3">
                  <span className="text-xs text-ink-3">#{tranches.length - i}</span>
                  <span className="num text-sm font-medium text-ink">{t.sizeText}</span>
                  <span className="num text-xs text-ink-3">
                    {fmtMark(t.entryMark)} → <span className="text-ink-2">{fmtMark(t.targetMark)}</span>
                  </span>
                  {t.synthetic && (
                    <span className="rounded-full bg-panel-2 px-2 py-0.5 text-2xs text-ink-3" title="Reconstructed by reconciling against the on-chain position size">
                      synth
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-3 text-xs text-ink-3">
                  <span>coll {fmtUsd(t.collateralUsd)}</span>
                  <span>{timeAgo(t.ts)}</span>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-panel-2">
                  <motion.div
                    className="h-full rounded-full bg-brand"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(100, t.progress * 100)}%` }}
                    transition={{ duration: 0.9, ease: [0.22, 0.61, 0.36, 1], delay: i * 0.05 }}
                  />
                </div>
                <span className={`num shrink-0 text-xs ${ripe ? "font-semibold text-brand" : t.movePct >= 0 ? "text-ink-2" : "text-down"}`}>
                  {ripe ? "ripe: closing" : `${t.movePct >= 0 ? "+" : ""}${t.movePct.toFixed(1)}% / +${t.neededPct.toFixed(1)}%`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-border px-4 py-3 text-xs leading-relaxed text-ink-3 sm:px-5">
        One netted position on Lighter; each deposit is tracked as its own tranche with its
        own entry. New fees never dilute an old tranche&apos;s progress.
      </p>
    </Panel>
  );
}
