"use client";

import { motion } from "motion/react";
import { cn } from "cn";
import { FEE_SPLIT_PCT } from "@/lib/doppler";

/**
 * Where a $100 fee goes, side by side with where it usually goes.
 *
 * Two bars, the same length, filled left to right as they enter the view: the
 * fill is the point (a fee being spent), so it moves once and then holds still.
 * The multiply split comes from FEE_SPLIT_PCT, the same constant the launch
 * form and the docs read, so this page cannot drift from the contracts.
 */

type Segment = { label: string; value: number; className: string; ink: string };

const ROWS: { name: string; caption: string; segments: Segment[] }[] = [
  {
    name: "A typical launchpad",
    caption: "Kept by the platform and the creator. Nothing comes back to the coin.",
    segments: [{ label: "Platform & creator", value: 100, className: "bg-[#c9d8cd]", ink: "text-ink-2" }],
  },
  {
    name: "multiply.cash",
    caption: `$${FEE_SPLIT_PCT.engine} becomes a position the coin owns, in a wallet of its own. 75% of every win buys the coin back.`,
    segments: [
      { label: "The coin's position", value: FEE_SPLIT_PCT.engine, className: "bg-brand", ink: "text-white" },
      { label: "Protocol", value: FEE_SPLIT_PCT.treasury, className: "bg-step-4/50", ink: "text-ink" },
      { label: "Doppler", value: FEE_SPLIT_PCT.doppler, className: "bg-line-2", ink: "text-ink" },
    ],
  },
];

export default function FeeDestination() {
  return (
    <div className="space-y-8">
      {ROWS.map((row, r) => (
        <div key={row.name}>
          <div className="mb-2.5 flex items-baseline justify-between gap-4">
            <span className={cn("font-display text-xl font-semibold", r === 1 ? "text-ink" : "text-ink-2")}>
              {row.name}
            </span>
            <span className="num text-sm text-ink-3">$100 fee</span>
          </div>
          {/*
            The track watches the viewport, not the segments: a segment starts
            at scaleX 0, a box with no area, and an observer on that is not a
            reliable trigger (on a phone two of three never filled).
          */}
          <motion.div
            className="flex h-14 w-full overflow-hidden rounded-[12px] bg-panel-2 sm:h-16"
            initial="empty"
            whileInView="full"
            viewport={{ once: true, margin: "-60px" }}
          >
            {row.segments.map((s, i) => (
              <motion.div
                key={s.label}
                className={cn("relative flex min-w-0 origin-left items-center overflow-hidden px-3", s.className)}
                style={{ width: `${s.value}%` }}
                variants={{
                  empty: { scaleX: 0 },
                  full: {
                    scaleX: 1,
                    transition: { duration: 0.9, delay: 0.15 + r * 0.35 + i * 0.18, ease: [0.16, 1, 0.3, 1] },
                  },
                }}
              >
                {s.value >= 12 ? (
                  <span className={cn("flex min-w-0 items-baseline gap-2 text-sm font-semibold", s.ink)}>
                    <span className="num shrink-0">${s.value}</span>
                    <span className="truncate font-medium opacity-90">{s.label}</span>
                  </span>
                ) : (
                  <span className={cn("num text-xs font-semibold", s.ink)}>${s.value}</span>
                )}
              </motion.div>
            ))}
          </motion.div>
          <p className="mt-2.5 max-w-[60ch] text-sm leading-relaxed text-ink-3">{row.caption}</p>
          {r === 1 && (
            <p className="mt-1 text-xs text-ink-3 sm:hidden">
              ${FEE_SPLIT_PCT.treasury} protocol, ${FEE_SPLIT_PCT.doppler} Doppler.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
