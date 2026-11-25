"use client";

import { motion } from "motion/react";
import { cn } from "cn";
import { EngineCoin } from "@/components/brand/EngineCoin";
import { PROFIT_SPLIT_PCT } from "@/lib/doppler";

/**
 * A memecoin, a perp, and the two in one token: the same four questions asked
 * three times.
 *
 * On a wide screen it is a ledger, so the answers line up across; the third
 * column is the night panel that breaks out of it. On a phone each way is its
 * own card, because a three-column table at 320px is three columns of hyphens.
 */
const QUESTIONS = ["What moves it", "When the hype stops", "When the trade wins", "When the trade loses"] as const;

const WAYS = [
  {
    name: "A memecoin",
    answers: ["New buyers", "It bleeds", "There is no trade", "There is no trade"],
  },
  {
    name: "A perp",
    answers: ["The asset", "It doesn't care", "You take profit", "You get liquidated"],
  },
  {
    name: "A token on multiply",
    answers: [
      "Both",
      "The perp keeps working",
      `The capital and ${PROFIT_SPLIT_PCT.buyback}% of the gain buy the token and burn it`,
      "Only the fees in it are lost",
    ],
  },
] as const;

export default function ThreeWays() {
  return (
    <>
      {/* wide: the ledger */}
      <div className="hidden grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.45fr)] md:grid">
        <div className="flex flex-col">
          <div className="h-[150px] lg:h-[190px]" />
          {QUESTIONS.map((q) => (
            <div key={q} className="flex min-h-[76px] items-center border-t border-line py-4 pr-4 text-sm text-ink-3">
              {q}
            </div>
          ))}
        </div>
        {WAYS.slice(0, 2).map((w) => (
          <div key={w.name} className="flex flex-col">
            <div className="flex h-[150px] items-end pb-4 font-display text-xl font-semibold text-ink-2 lg:h-[190px]">{w.name}</div>
            {w.answers.map((a, i) => (
              <div key={QUESTIONS[i]} className="flex min-h-[76px] items-center border-t border-line py-4 pr-4 text-base text-ink-2">
                {a}
              </div>
            ))}
          </div>
        ))}
        <motion.div
          className="intro-night relative isolate flex flex-col overflow-hidden rounded-[22px] text-night-ink"
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <EngineCoin className="pointer-events-none absolute top-3 right-3 -z-10 w-[124px] lg:top-4 lg:right-5 lg:w-[160px]" />
          <div className="flex h-[150px] items-end px-6 pb-4 font-display text-xl font-semibold lg:h-[190px] lg:px-7">
            <span className="max-w-[8ch] leading-tight lg:max-w-none lg:whitespace-nowrap">A token on multiply</span>
          </div>
          {WAYS[2].answers.map((a, i) => (
            <div
              key={QUESTIONS[i]}
              className="flex min-h-[76px] items-center border-t border-night-line bg-night/55 px-6 py-4 text-lg font-semibold text-mint lg:px-7"
            >
              {a}
            </div>
          ))}
        </motion.div>
      </div>

      {/* phone: three cards, the last one at night */}
      <div className="space-y-4 md:hidden">
        {WAYS.map((w, k) => {
          const night = k === 2;
          return (
            <div
              key={w.name}
              className={cn(
                "relative isolate overflow-hidden rounded-[18px] px-5 pt-5 pb-2",
                night ? "intro-night text-night-ink" : "border border-line bg-panel"
              )}
            >
              {night && <EngineCoin className="pointer-events-none mx-auto mb-3 w-[62%] max-w-[230px]" />}
              <div className={cn("font-display text-xl font-semibold", !night && "text-ink-2")}>{w.name}</div>
              <dl className="mt-3">
                {w.answers.map((a, i) => (
                  <div
                    key={QUESTIONS[i]}
                    className={cn("flex items-baseline justify-between gap-4 border-t py-3", night ? "border-night-line" : "border-line")}
                  >
                    <dt className={cn("shrink-0 text-xs", night ? "text-night-ink-2" : "text-ink-3")}>{QUESTIONS[i]}</dt>
                    <dd className={cn("min-w-0 text-right text-sm", night ? "font-semibold text-mint" : "text-ink-2")}>{a}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </>
  );
}
