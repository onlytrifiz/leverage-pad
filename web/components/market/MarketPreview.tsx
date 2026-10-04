"use client";

import type { CoinListItem } from "@/lib/types";
import { Reveal, RevealItem } from "@/components/motion";
import CoinCard from "./CoinCard";

/** the home page's window on the market: the three biggest coins, as cards */
export default function MarketPreview({ items }: { items: CoinListItem[] }) {
  const top = [...items]
    .sort((a, b) => Number(b.perpOpen) - Number(a.perpOpen) || (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))
    .slice(0, 3);
  return (
    <Reveal className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {top.map((item) => (
        <RevealItem key={item.coin.token} className="min-w-0">
          <CoinCard item={item} pnlUsd={null} />
        </RevealItem>
      ))}
    </Reveal>
  );
}
