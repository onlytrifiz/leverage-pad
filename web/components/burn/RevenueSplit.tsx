"use client";

import { motion } from "motion/react";
import { cn } from "cn";
import { FEE_SPLIT_PCT, FLYWHEEL, PROFIT_SPLIT_PCT } from "@/lib/doppler";

/**
 * From what is paid to what is burned: two bars, one per source, each cut twice. The outer cut is
 * the protocol's share of it, the inner one is the buyback's share of that.
 */
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

const SOURCES = [
  { title: "From every $100 of trading fees", share: FEE_SPLIT_PCT.treasury, rest: `${money(FEE_SPLIT_PCT.engine)} loads the token's own position, ${money(FEE_SPLIT_PCT.doppler)} goes to Doppler.` },
  { title: "From every $100 a take-profit gains", share: PROFIT_SPLIT_PCT.treasury, rest: `${money(PROFIT_SPLIT_PCT.buyback)} and all the capital buy back the token that made it.` },
];

export default function RevenueSplit() {
  return (
    <div className="grid gap-10 lg:grid-cols-2 lg:gap-14">
      {SOURCES.map((s) => {
        const burn = (s.share * FLYWHEEL.buybackPct) / 100;
        const keep = s.share - burn;
        return (
          <div key={s.title} className="min-w-0">
            <h3 className="font-display text-xl font-semibold text-ink">{s.title}</h3>
            <motion.div className="mt-4 flex h-14 overflow-hidden rounded-[12px] bg-panel-2" initial="empty" whileInView="full" viewport={{ once: true, margin: "-60px" }}>
              {[
                { w: burn, c: "bg-brand text-white", v: burn },
                { w: keep, c: "bg-step-4/50 text-ink", v: null },
              ].map((p, i) => (
                <motion.div
                  key={p.c}
                  className={cn("flex min-w-0 origin-left items-center justify-center", p.c)}
                  style={{ width: `${p.w}%` }}
                  variants={{ empty: { scaleX: 0 }, full: { scaleX: 1, transition: { duration: 0.8, delay: 0.1 + i * 0.2, ease: [0.16, 1, 0.3, 1] } } }}
                >
                  {p.v != null && <span className="num text-2xs font-semibold sm:text-sm">{money(p.v)}</span>}
                </motion.div>
              ))}
            </motion.div>
            <dl className="mt-4 grid gap-2 text-sm">
              <div className="flex items-baseline gap-2.5">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] bg-brand" />
                <dt className="text-ink">Buys $MULTIPLY and burns it</dt>
                <dd className="num ml-auto font-semibold text-ink">{money(burn)}</dd>
              </div>
              <div className="flex items-baseline gap-2.5">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] bg-step-4/50" />
                <dt className="text-ink-2">Stays in the treasury</dt>
                <dd className="num ml-auto text-ink-2">{money(keep)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-sm leading-relaxed text-ink-3">{s.rest}</p>
          </div>
        );
      })}
    </div>
  );
}
