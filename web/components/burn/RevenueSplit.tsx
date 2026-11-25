"use client";

import { ArrowLeftRight, Target } from "lucide-react";
import { motion } from "motion/react";
import { FEE_SPLIT_PCT, FLYWHEEL, PROFIT_SPLIT_PCT } from "@/lib/doppler";

/**
 * Two sources into one pot, and the pot cut once. Shares only: an amount here would be an example,
 * and an example reads as the size of the thing.
 */
const SOURCES = [
  { icon: ArrowLeftRight, pct: FEE_SPLIT_PCT.treasury, title: "of every trading fee", text: "On every token launched here, at every swap." },
  { icon: Target, pct: PROFIT_SPLIT_PCT.treasury, title: "of every take-profit's gain", text: "Each time a token's position closes in profit." },
];

const CUTS = [
  { pct: FLYWHEEL.buybackPct, label: "Buys $MULTIPLY and burns it", className: "bg-brand text-white" },
  { pct: FLYWHEEL.treasuryPct, label: "Treasury", className: "bg-step-4/50 text-ink" },
];

export default function RevenueSplit() {
  return (
    <div>
      <ul className="grid gap-px overflow-hidden rounded-[18px] border border-line bg-line sm:grid-cols-2">
        {SOURCES.map(({ icon: Icon, ...s }) => (
          <li key={s.title} className="flex min-w-0 items-center gap-4 bg-panel p-5 sm:p-6">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
              <Icon size={20} strokeWidth={1.75} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-lg leading-snug font-semibold text-ink">
                <span className="num">{s.pct}%</span> {s.title}
              </span>
              <span className="mt-0.5 block text-sm text-ink-3">{s.text}</span>
            </span>
          </li>
        ))}
      </ul>

      {/* the two of them, into one */}
      <svg aria-hidden viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-10 w-full text-brand">
        {[25, 75].map((x) => (
          <path
            key={x}
            d={`M${x},0 C${x},24 50,14 50,40`}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.55"
            strokeWidth="2"
            strokeDasharray="4 8"
            vectorEffect="non-scaling-stroke"
            className="flow-dash"
          />
        ))}
      </svg>

      <motion.div
        className="flex h-20 overflow-hidden rounded-[16px] bg-panel-2 sm:h-24"
        initial="empty"
        whileInView="full"
        viewport={{ once: true, margin: "-60px" }}
      >
        {CUTS.map((c, i) => (
          <motion.div
            key={c.label}
            className={`flex min-w-0 origin-left flex-col justify-center px-4 sm:px-6 ${c.className}`}
            style={{ width: `${c.pct}%` }}
            variants={{
              empty: { scaleX: 0 },
              full: { scaleX: 1, transition: { duration: 0.9, delay: 0.15 + i * 0.25, ease: [0.16, 1, 0.3, 1] } },
            }}
          >
            <span className="num text-2xl leading-none font-semibold sm:text-4xl">{c.pct}%</span>
            <span className="mt-1.5 text-2xs leading-tight font-medium opacity-90 sm:text-sm">{c.label}</span>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
