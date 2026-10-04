"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "cn";
import { useMarkets } from "@/components/markets-provider";
import AssetIcon from "@/components/AssetIcon";
import { fmtChange, fmtMark } from "@/lib/format";

/**
 * What is moving today on Lighter, as launch ideas.
 *
 * The right asset at the right moment is the whole thesis, so the market page
 * leads with the moment: the biggest 24h moves among the perps a coin can back,
 * each one a link to the launch form already set to that asset and to the side
 * of the move. Live from the shared Lighter feed; nothing here is curated.
 */
export default function MoversStrip({ tone = "paper" }: { tone?: "paper" | "night" }) {
  const night = tone === "night";
  const { markets, loaded } = useMarkets();
  const movers = [...markets]
    .filter((m) => m.change24h != null && m.mark != null)
    .sort((a, b) => Math.abs(b.change24h!) - Math.abs(a.change24h!))
    .slice(0, 10);

  return (
    <section aria-label="Moving today">
      <div className="flex items-end justify-between gap-4">
        <h2 className={cn("font-display text-2xl font-semibold", night && "text-night-ink")}>Moving today</h2>
        <span className={cn("hidden text-xs sm:block", night ? "text-night-ink-2" : "text-ink-3")}>
          Launch a coin on the move, one tap
        </span>
      </div>
      {/* scroll-padding matches the gutter: snapping otherwise parks the first card on the window's edge */}
      <div className="-mx-4 mt-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:-mx-5 sm:scroll-px-5 sm:px-5 [&::-webkit-scrollbar]:hidden">
        {!loaded &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={cn("h-[132px] w-[200px] shrink-0 animate-pulse rounded-[16px]", night ? "bg-night-2" : "bg-panel-2")} />
          ))}
        {movers.map((m) => {
          const up = (m.change24h ?? 0) >= 0;
          const side = up ? "long" : "short";
          return (
            <Link
              key={m.symbol}
              href={`/launch?market=${encodeURIComponent(m.symbol)}&side=${side}`}
              className={cn(
                "group relative w-[200px] shrink-0 snap-start overflow-hidden rounded-[16px] border p-4 transition-all hover:-translate-y-0.5",
                night
                  ? "border-night-line bg-night-2/80 hover:border-mint/40 hover:shadow-[0_18px_40px_-20px_rgba(140,232,176,0.35)]"
                  : "border-line bg-panel hover:border-line-2 hover:shadow-[0_18px_40px_-24px_rgba(12,52,32,0.45)]"
              )}
            >
              <div className="flex items-center gap-2">
                <AssetIcon symbol={m.symbol} size={22} />
                <span className={cn("truncate font-semibold", night ? "text-night-ink" : "text-ink")}>{m.symbol}</span>
              </div>
              <div
                className={cn(
                  "num mt-3 text-2xl font-semibold",
                  up ? (night ? "text-night-up" : "text-up") : night ? "text-night-down" : "text-down"
                )}
              >
                {fmtChange(m.change24h, 2)}
              </div>
              <div className={cn("num text-xs", night ? "text-night-ink-2" : "text-ink-3")}>{fmtMark(m.mark)}</div>
              <div className={cn("mt-3 flex items-center justify-between text-xs font-semibold", night ? "text-mint" : "text-brand")}>
                <span>Launch {side}</span>
                <ArrowUpRight size={14} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
