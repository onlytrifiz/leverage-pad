"use client";

import { motion } from "motion/react";

/**
 * The engine as a staircase: four stages climbing like the chevrons in the
 * logo, colour running from forest to mint. It is the only decorative element
 * on the page — everything else stays flat and legible.
 *
 * The steps now arrive in order rather than all at once, which is the whole
 * point of the shape: the reader watches a fee become a burn.
 */
const STEPS = [
  { label: "Trading fees", sub: "1 to 5% per swap, in USDG" },
  { label: "Perp on Lighter", sub: "100% of fees" },
  { label: "Profits return", sub: "75% buyback" },
  { label: "Buyback & burn", sub: "Supply ↓" },
];

export default function EngineStairs() {
  return (
    <motion.div
      className="stair mt-2"
      aria-label="Fee engine: trading fees fund a perp on Lighter, profits buy back and burn the coin"
      initial="hidden"
      animate="shown"
      variants={{ shown: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } } }}
    >
      {STEPS.map((s, i) => (
        <motion.div
          key={s.label}
          className="stair-step"
          variants={{
            hidden: { opacity: 0, y: 14 },
            shown: { opacity: 1, y: 0, transition: { duration: 0.42, ease: [0.22, 0.61, 0.36, 1] } },
          }}
          style={
            {
              "--i": i,
              "--step-color": `var(--color-step-${i + 1})`,
            } as React.CSSProperties
          }
        >
          <div className="text-sm font-semibold leading-tight text-ink">{s.label}</div>
          <div className="mt-0.5 text-xs text-ink-3">{s.sub}</div>
        </motion.div>
      ))}
    </motion.div>
  );
}
