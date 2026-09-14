"use client";

import { motion } from "motion/react";
import { fmtPct } from "@/lib/format";
import { AnimatedNumber } from "@/components/motion";

/**
 * The page's signature: burned coins as a climbing odometer with the bar of
 * consumed supply. The burn is the product's promise — the rest of the page
 * stays quiet, this number moves.
 *
 * The bespoke requestAnimationFrame loop that used to live here is gone: it
 * duplicated `AnimatedNumber` and carried its own reduced-motion check, which
 * is now handled once, for the whole site, by MotionConfig.
 */
export default function BurnOdometer({
  burned,
  burnedPct,
}: {
  burned: number;
  burnedPct: number | null;
}) {
  const pct = burnedPct != null ? Math.min(100, burnedPct * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 text-xs text-ink-3">Tokens burned</div>
      <div className="num text-3xl font-semibold leading-none text-brand">
        <AnimatedNumber value={burned} format="int" countOnMount duration={1.4} />
      </div>
      {burnedPct != null && (
        <div className="mt-3">
          <div className="h-[5px] w-full overflow-hidden rounded-full bg-panel-2">
            <motion.div
              className="h-full rounded-full bg-brand"
              initial={{ width: 0 }}
              whileInView={{ width: `${pct}%` }}
              viewport={{ once: true }}
              transition={{ duration: 1.1, ease: [0.22, 0.61, 0.36, 1] }}
            />
          </div>
          <div className="mt-2 text-xs text-ink-3">{fmtPct(burnedPct)} of supply destroyed</div>
        </div>
      )}
    </div>
  );
}
