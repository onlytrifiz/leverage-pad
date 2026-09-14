"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { CoinListItem } from "@/lib/types";
import { fmtUsd, fmtInt } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { DemoBadge } from "./Badge";
import { Reveal, RevealItem, LivePulse } from "@/components/motion";
import { ChartColumnIncreasing } from "@/components/animate-ui/icons/chart-column-increasing";
import { ChartColumnDecreasing } from "@/components/animate-ui/icons/chart-column-decreasing";
import { Clock } from "@/components/animate-ui/icons/clock";
import { Search } from "@/components/animate-ui/icons/search";
import AssetIcon from "./AssetIcon";

/**
 * The coin list. "Stock-backed" means a non-crypto underlying — the angle that
 * only exists on Robinhood Chain: NVDA, TSLA, ANTHROPIC.
 *
 * Two renderings of one dataset: a row grid from `md` up, stacked cards below
 * it. The single grid used to sit in a 620px scroller, so on a phone the most
 * important column — market cap — started off-screen and had to be swiped to.
 */

const CRYPTO_MARKETS = new Set([
  "BTC", "ETH", "SOL", "HYPE", "ZEC", "DOGE", "XRP", "SUI", "LINK", "AVAX",
]);

type Tab = "all" | "stock" | "crypto" | "shorts" | "new";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All coins" },
  { key: "stock", label: "Stock-backed" },
  { key: "crypto", label: "Crypto-backed" },
  { key: "shorts", label: "Shorts" },
  { key: "new", label: "New" },
];

const COLUMNS = "grid-cols-[1.5fr_1.1fr_0.9fr_0.8fr_0.8fr]";

function EngineBadge({ open }: { open: boolean }) {
  return open ? (
    <Badge variant="brand">
      <LivePulse tone="brand" />
      Perp live
    </Badge>
  ) : (
    <Badge variant="secondary" className="text-ink-3">
      <Clock aria-hidden size={12} animation="default" loop loopDelay={2600} />
      Accumulating
    </Badge>
  );
}

export default function CoinTable({ items }: { items: CoinListItem[] }) {
  const [tab, setTab] = useState<Tab>("all");
  /* read the clock once: calling Date.now() while filtering makes render impure */
  const [mountedAt] = useState(() => Date.now());
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(({ coin }) => {
      if (tab === "stock" && CRYPTO_MARKETS.has(coin.market)) return false;
      if (tab === "crypto" && !CRYPTO_MARKETS.has(coin.market)) return false;
      if (tab === "shorts" && coin.side !== "short") return false;
      if (tab === "new" && mountedAt - new Date(coin.createdAt).getTime() > 3 * 86_400_000)
        return false;
      if (needle)
        return (
          coin.symbol.toLowerCase().includes(needle) ||
          coin.name.toLowerCase().includes(needle) ||
          coin.market.toLowerCase().includes(needle) ||
          coin.token.toLowerCase() === needle
        );
      return true;
    });
  }, [items, tab, q, mountedAt]);

  return (
    <section aria-label="Launched coins">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/*
          `min-w-0` is the whole fix: as a flex item the tab strip defaults to
          min-width:auto, refuses to shrink below its five labels and drags the
          document out to 377px on a 320px screen.
        */}
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="w-full min-w-0 sm:w-auto"
        >
          {/*
            The tab strip scrolls instead of wrapping: five labels do not fit on
            a 320px screen, and a wrapped strip pushes the table down a row for
            no gain.
          */}
          <TabsList className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="shrink-0">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="group/search relative w-full sm:max-w-[260px]">
          <Search
            aria-hidden
            size={15}
            animate={q.length > 0}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search ticker, name or market"
            aria-label="Search coins"
            className="w-full pl-9"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <Panel className="mt-4">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No coins here yet</EmptyTitle>
              <EmptyDescription>Clear the search or switch tab.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Panel>
      ) : (
        <>
          {/* header row: from md up, where the grid exists */}
          <div className={`mt-4 hidden gap-3 px-5 pb-2 md:grid ${COLUMNS}`}>
            {["Coin", "Underlying", "Engine", "Burned", "Market cap"].map((h) => (
              <span
                key={h}
                className={`text-xs font-medium text-ink-3 ${
                  h === "Burned" || h === "Market cap" ? "text-right" : ""
                }`}
              >
                {h}
              </span>
            ))}
          </div>

          <Reveal as="ul" className="mt-4 flex flex-col gap-2 md:mt-0">
            {filtered.map(({ coin, marketCapUsd, burnedTokens, perpOpen, demo }) => (
              <RevealItem as="li" key={coin.token}>
                <Link
                  href={`/token/${coin.token}`}
                  className={`block rounded-[14px] border border-border bg-card px-4 py-4 shadow-[0_1px_2px_rgba(12,52,32,0.04)] transition-[color,background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[0_6px_18px_-8px_rgba(12,52,32,0.28)] sm:px-5 md:grid md:items-center md:gap-3 ${COLUMNS}`}
                >
                  {/* identity */}
                  <div className="flex min-w-0 items-center justify-between gap-3 md:block">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-md font-semibold text-ink">
                          ${coin.symbol}
                        </span>
                        {demo && <DemoBadge />}
                      </div>
                      <div className="mt-0.5 truncate text-sm text-ink-3">{coin.name}</div>
                    </div>
                    {/* on a phone the market cap belongs next to the name, not four swipes away */}
                    <span className="num shrink-0 text-md font-semibold text-ink md:hidden">
                      {fmtUsd(marketCapUsd)}
                    </span>
                  </div>

                  <span
                    className={`mt-3 flex min-w-0 items-center gap-2 text-sm font-medium md:mt-0 ${
                      coin.side === "long" ? "text-up" : "text-down"
                    }`}
                  >
                    <AssetIcon symbol={coin.market} size={20} />
                    {coin.side === "long" ? (
                      <ChartColumnIncreasing aria-hidden size={15} animateOnHover />
                    ) : (
                      <ChartColumnDecreasing aria-hidden size={15} animateOnHover />
                    )}
                    <span className="truncate">
                      {coin.leverage}× {coin.side} {coin.market}
                    </span>
                  </span>

                  <div className="mt-3 flex min-w-0 items-center justify-between gap-3 md:mt-0 md:block">
                    <EngineBadge open={perpOpen} />
                    <span className="num text-sm text-brand md:hidden">
                      {fmtInt(burnedTokens)} burned
                    </span>
                  </div>

                  <span className="num hidden text-right text-sm text-brand md:block">
                    {fmtInt(burnedTokens)}
                  </span>
                  <span className="num hidden text-right text-md font-semibold text-ink md:block">
                    {fmtUsd(marketCapUsd)}
                  </span>
                </Link>
              </RevealItem>
            ))}
          </Reveal>
        </>
      )}
    </section>
  );
}
