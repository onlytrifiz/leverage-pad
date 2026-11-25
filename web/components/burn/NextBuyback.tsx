"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { FLYWHEEL } from "@/lib/doppler";
import { fmtUsd } from "@/lib/format";

/** what has been set aside, how far it is from a buy, and when the keeper looks next */
export default function NextBuyback({ waitingUsd, lastRunAt }: { waitingUsd: number; lastRunAt: number | null }) {
  const reduced = useReducedMotion();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  const left = now != null && lastRunAt ? Math.max(0, Math.round((lastRunAt + FLYWHEEL.everyMin * 60_000 - now) / 1000)) : null;
  const ready = waitingUsd >= FLYWHEEL.minUsd;
  const frac = Math.max(0, Math.min(1, waitingUsd / FLYWHEEL.minUsd));

  return (
    <section aria-label="Next buyback" className="rounded-[18px] border border-line bg-panel p-5 sm:p-6">
      <div className="grid grid-cols-2 gap-6">
        <div className="min-w-0">
          <div className="text-xs text-ink-3">Set aside so far</div>
          <div className="num mt-1 text-3xl font-semibold text-ink sm:text-4xl">{fmtUsd(waitingUsd)}</div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-xs text-ink-3">Next look</div>
          <div className="num mt-1 text-3xl font-semibold text-ink tabular-nums sm:text-4xl">
            {left == null ? "—" : left === 0 ? "now" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
          </div>
        </div>
      </div>
      <div className="mt-5 h-2 overflow-hidden rounded-full bg-panel-2">
        <motion.div
          className="h-full origin-left rounded-full bg-brand"
          initial={false}
          animate={{ scaleX: frac }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 90, damping: 20 }}
        />
      </div>
      <p className="mt-2.5 text-sm text-ink-3">
        {ready
          ? `Enough to buy: it goes out at the next look, in a size that moves the price by ${FLYWHEEL.impactPct}% at most.`
          : `A buyback goes out from ${fmtUsd(FLYWHEEL.minUsd, 0)} up. What is below it waits and adds up.`}
      </p>
    </section>
  );
}
