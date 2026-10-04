"use client";

import AssetIcon from "./AssetIcon";
import { useMarkets } from "./markets-provider";
import { fmtMark, fmtChange } from "@/lib/format";
import { motion } from "motion/react";
import type { MarketRow } from "@/lib/lighter";

/**
 * Price tape for the Lighter perps, under the nav — the pulse of the venue the
 * positions run on. Pauses on hover, still with prefers-reduced-motion (where it
 * degrades to a scrollable static list rather than disappearing).
 *
 * It scrolls away with the page: the header floats as a pill, and a tape pinned under it
 * would leave a strip of page scrolling between the two.
 */
export default function TickerTape() {
  const { markets, loaded } = useMarkets();
  const rows = markets.slice(0, 24);

  if (!rows.length) {
    return (
      <div
        className="relative h-[var(--tape-h)] border-y border-border bg-card"
        aria-hidden={!loaded}
      />
    );
  }

  const cell = (m: MarketRow, i: number) => (
    <span key={i} className="mx-5 inline-flex shrink-0 items-center gap-1.5 text-xs">
      <AssetIcon symbol={m.symbol} size={16} />
      <span className="font-medium text-ink">{m.symbol}</span>
      <span className="num text-ink-2">{fmtMark(m.mark)}</span>
      {m.change24h != null && (
        <span className={`num ${m.change24h >= 0 ? "text-up" : "text-down"}`}>
          {fmtChange(m.change24h)}
        </span>
      )}
    </span>
  );

  return (
    <motion.div
      className="group relative overflow-hidden border-y border-border bg-card"
      aria-label="Lighter perp prices"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div className="flex w-max animate-[tape_60s_linear_infinite] py-2 group-hover:[animation-play-state:paused] motion-reduce:w-full motion-reduce:animate-none motion-reduce:overflow-x-auto">
        {rows.map(cell)}
        {rows.map((m, i) => cell(m, i + rows.length))}
      </div>
    </motion.div>
  );
}
