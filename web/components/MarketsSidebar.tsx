"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Reveal, RevealItem, LivePulse } from "@/components/motion";
import { Sparkles } from "@/components/animate-ui/icons/sparkles";
import { fmtMark, fmtChange } from "@/lib/format";
import AssetIcon from "./AssetIcon";
import { useMarkets } from "./markets-provider";

/** The Lighter perps, by volume: what a coin can be pointed at. */
export default function MarketsSidebar() {
  const { markets, loaded } = useMarkets();

  return (
    <div className="rail">
      <RailHead title="Markets" meta="Lighter" />
      <div className="rail-body">
        {!loaded &&
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-2 px-2 py-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-14" />
            </div>
          ))}
        <Reveal className="contents" trigger="mount">
        {markets.map((m) => (
          <RevealItem
            key={m.marketId}
            className="flex min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted"
          >
            <span className="flex min-w-0 items-center gap-2 text-md font-medium text-ink">
              <AssetIcon symbol={m.symbol} size={20} />
              <span className="truncate">{m.symbol}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="num block text-sm text-ink-2">{fmtMark(m.mark)}</span>
              {m.change24h != null && (
                <span
                  className={`num block text-xs ${m.change24h >= 0 ? "text-up" : "text-down"}`}
                >
                  {fmtChange(m.change24h)}
                </span>
              )}
            </span>
          </RevealItem>
        ))}
        </Reveal>
      </div>
      <Button
        size="xl"
        className="group/launch mt-3 w-full shrink-0"
        nativeButton={false}
        render={<Link href="/launch" />}
      >
        <Sparkles aria-hidden size={15} animateOnHover />
        Launch a coin
      </Button>
    </div>
  );
}

export function RailHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border pb-2.5">
      <span className="text-sm font-semibold text-ink">{title}</span>
      {meta && (
        <span className="flex items-center gap-1.5 text-xs text-ink-3">
          <LivePulse />
          {meta}
        </span>
      )}
    </div>
  );
}
