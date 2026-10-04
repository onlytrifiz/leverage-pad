"use client";

import { CircleDollarSign, Flame, Hourglass, TrendingUp } from "lucide-react";
import type { CoinDetail } from "@/lib/types";
import { fmtInt } from "@/lib/format";
import { AnimatedNumber } from "@/components/motion";

/**
 * This coin's fees, followed from the swap to the burn, with its own numbers.
 *
 * The same four stations as the home page's loop, but here they hold money:
 * what the pool collected, what reached the position, what is waiting to buy
 * back, and what has been burned. The dashes between them flow in the
 * direction the money travels.
 */
export default function EngineFlow({ detail }: { detail: CoinDetail }) {
  const { stats, coin } = detail;
  const stations = [
    {
      icon: CircleDollarSign,
      label: "Fees collected",
      value: <AnimatedNumber value={stats.feesCollectedUsd} format="usd" countOnMount />,
      note: "in USDG, from every swap",
    },
    {
      icon: TrendingUp,
      label: "Sent to the position",
      value: <AnimatedNumber value={stats.perpFundedUsd} format="usd" countOnMount />,
      note: `collateral on Lighter, ${coin.leverage}x`,
    },
    {
      icon: Hourglass,
      label: "Waiting to buy back",
      value: <AnimatedNumber value={stats.buybackReserveUsd} format="usd" countOnMount />,
      note: "realized profit, 75% share",
    },
    {
      icon: Flame,
      label: "Burned",
      value: <AnimatedNumber value={stats.burnedTokens} format="int" countOnMount />,
      note:
        stats.burnedPct != null && stats.burnedPct > 0
          ? `${(stats.burnedPct * 100).toFixed(3)}% of supply`
          : `of ${fmtInt(coin.initialSupply ?? 1e9)} tokens`,
    },
  ];

  return (
    <section className="rounded-[18px] border border-line bg-panel p-5 sm:p-6">
      <h2 className="font-display text-xl font-semibold">Where the fees went</h2>
      <ol className="mt-6 grid grid-cols-1 gap-0 md:grid-cols-4">
        {stations.map((s, i) => {
          const Icon = s.icon;
          return (
            <li key={s.label} className="relative flex gap-4 pb-7 md:block md:pr-5 md:pb-0">
              {i < stations.length - 1 && (
                <svg aria-hidden className="absolute top-11 bottom-0 left-[19px] h-[calc(100%-44px)] w-[2px] md:top-[19px] md:right-0 md:bottom-auto md:left-11 md:h-[2px] md:w-[calc(100%-44px)]" preserveAspectRatio="none">
                  <line x1="1" y1="0" x2="1" y2="100%" className="md:hidden" stroke="var(--color-brand)" strokeWidth="2" strokeDasharray="4 8" strokeOpacity="0.6" />
                  <line x1="0" y1="1" x2="100%" y2="1" className="flow-dash hidden md:block" stroke="var(--color-brand)" strokeWidth="2" strokeDasharray="4 8" strokeOpacity="0.6" />
                </svg>
              )}
              <span className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                <Icon size={18} strokeWidth={1.75} aria-hidden />
              </span>
              <div className="min-w-0 md:mt-4">
                <div className="text-xs text-ink-3">{s.label}</div>
                <div className="num mt-1 truncate text-2xl font-semibold text-ink">{s.value}</div>
                <div className="mt-0.5 text-xs text-ink-3">{s.note}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
