"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "cn";
import type { CoinListItem } from "@/lib/types";
import { fmtChange, fmtInt, fmtSignedUsd, fmtUsd } from "@/lib/format";
import { useMarkets } from "@/components/markets-provider";
import { CoinSeal } from "@/components/brand/CoinSeal";
import { Guilloche } from "@/components/brand/Guilloche";
import AssetIcon from "@/components/AssetIcon";
import CoinCard from "./CoinCard";

/**
 * Every coin, as a board you can cut: filter by what backs it, sort by what
 * you care about, search, and switch between cards and a dense list.
 *
 * The grid always ends with an open slot: a coin that is not launched yet. On a
 * young market that is what fills the row honestly, and it points at the asset
 * moving most today.
 */

const CRYPTO = new Set(["BTC", "ETH", "SOL", "HYPE", "ZEC", "DOGE", "XRP", "SUI", "LINK", "AVAX", "LIT"]);

type Filter = "all" | "stock" | "crypto" | "shorts" | "new";
type Sort = "mcap" | "new" | "launch" | "burned" | "fees";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "stock", label: "Stock-backed" },
  { key: "crypto", label: "Crypto-backed" },
  { key: "shorts", label: "Shorts" },
  { key: "new", label: "New" },
];

const SORTS: { key: Sort; label: string }[] = [
  { key: "mcap", label: "Market cap" },
  { key: "launch", label: "Since launch" },
  { key: "new", label: "Newest" },
  { key: "burned", label: "Most burned" },
  { key: "fees", label: "Most fees" },
];

const since = (i: CoinListItem) =>
  i.marketCapUsd != null && i.coin.openingMcapUsd > 0 ? (i.marketCapUsd / i.coin.openingMcapUsd - 1) * 100 : null;

export default function CoinsBoard({ items, pnl }: { items: CoinListItem[]; pnl: Record<string, number | null> }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("mcap");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [q, setQ] = useState("");
  const [mountedAt] = useState(() => Date.now());

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = items.filter(({ coin }) => {
      if (filter === "stock" && CRYPTO.has(coin.market)) return false;
      if (filter === "crypto" && !CRYPTO.has(coin.market)) return false;
      if (filter === "shorts" && coin.side !== "short") return false;
      if (filter === "new" && mountedAt - new Date(coin.createdAt).getTime() > 3 * 86_400_000) return false;
      if (!needle) return true;
      return (
        coin.symbol.toLowerCase().includes(needle) ||
        coin.name.toLowerCase().includes(needle) ||
        coin.market.toLowerCase().includes(needle) ||
        coin.token.toLowerCase() === needle
      );
    });
    const key: Record<Sort, (i: CoinListItem) => number> = {
      mcap: (i) => i.marketCapUsd ?? -1,
      launch: (i) => since(i) ?? -Infinity,
      new: (i) => new Date(i.coin.createdAt).getTime(),
      burned: (i) => i.burnedTokens,
      fees: (i) => i.feesCollectedUsd,
    };
    return out.sort((a, b) => key[sort](b) - key[sort](a));
  }, [items, filter, sort, q, mountedAt]);

  return (
    <section aria-label="Coins">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex max-w-full min-w-0 gap-1 overflow-x-auto rounded-xl bg-panel-2 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={cn(
                "relative shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                filter === f.key ? "text-ink" : "text-ink-3 hover:text-ink"
              )}
            >
              {filter === f.key && (
                <motion.span layoutId="board-filter" className="absolute inset-0 rounded-lg bg-panel shadow-sm" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
              )}
              <span className="relative">{f.label}</span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <label className="relative min-w-0 flex-1 sm:w-[240px] sm:flex-none">
            <span className="sr-only">Search coins</span>
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ticker, name or asset"
              className="h-9 w-full rounded-lg border border-line bg-panel pr-3 pl-9 text-sm text-ink placeholder:text-ink-3 focus:border-brand"
            />
          </label>
          <label className="shrink-0">
            <span className="sr-only">Sort by</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="h-9 rounded-lg border border-line bg-panel px-2.5 text-sm text-ink focus:border-brand"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex shrink-0 rounded-lg border border-line bg-panel p-0.5">
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                aria-label={v === "grid" ? "Cards" : "List"}
                className={cn("rounded-md p-1.5 transition-colors", view === v ? "bg-brand-soft text-brand" : "text-ink-3 hover:text-ink")}
              >
                {v === "grid" ? <LayoutGrid size={15} /> : <List size={15} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* board */}
      {view === "grid" ? (
        <motion.div layout className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {rows.map((item) => (
              <motion.div
                key={item.coin.token}
                layout
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="min-w-0"
              >
                <CoinCard item={item} pnlUsd={pnl[item.coin.token.toLowerCase()] ?? null} />
              </motion.div>
            ))}
          </AnimatePresence>
          <motion.div layout className="min-w-0">
            <OpenSlot />
          </motion.div>
        </motion.div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-[18px] border border-line bg-panel">
          {rows.length === 0 && <p className="p-6 text-sm text-ink-3">No coin matches. Try another filter.</p>}
          {rows.map((item, i) => {
            const s = since(item);
            const p = pnl[item.coin.token.toLowerCase()] ?? null;
            return (
              <Link
                key={item.coin.token}
                href={`/token/${item.coin.token}`}
                className={cn(
                  "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-panel-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_0.8fr_0.8fr_0.8fr_0.8fr]",
                  i > 0 && "border-t border-line"
                )}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <CoinSeal leverage={item.coin.leverage} side={item.coin.side} takeProfitPct={item.coin.takeProfitPct} size={34} rings={2} spin={0} className="shrink-0 text-brand" />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-ink">${item.coin.symbol}</span>
                    <span className="block truncate text-xs text-ink-3">{item.coin.name}</span>
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
                  <AssetIcon symbol={item.coin.market} size={16} />
                  <span className="truncate">
                    {item.coin.leverage}x {item.coin.side} {item.coin.market}
                  </span>
                </span>
                <span className={cn("num text-right text-sm font-semibold md:text-left", s == null ? "text-ink" : s >= 0 ? "text-up" : "text-down")}>
                  {fmtChange(s, 1)}
                </span>
                <span className="num hidden text-sm text-ink md:block">{fmtUsd(item.marketCapUsd)}</span>
                <span className="num hidden text-sm text-ink md:block">{fmtInt(item.burnedTokens)}</span>
                <span className={cn("num hidden text-sm md:block", item.perpOpen ? ((p ?? 0) >= 0 ? "text-up" : "text-down") : "text-ink-3")}>
                  {item.perpOpen ? (p == null ? "live" : fmtSignedUsd(p)) : "accumulating"}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {view === "grid" && rows.length === 0 && (
        <p className="mt-4 text-sm text-ink-3">No coin matches. Try another filter, or launch the first one.</p>
      )}
    </section>
  );
}

/** the slot at the end of the grid: the coin that does not exist yet */
function OpenSlot() {
  const { markets } = useMarkets();
  const top = [...markets]
    .filter((m) => m.change24h != null)
    .sort((a, b) => Math.abs(b.change24h!) - Math.abs(a.change24h!))[0];
  const side = (top?.change24h ?? 0) >= 0 ? "long" : "short";
  const href = top ? `/launch?market=${encodeURIComponent(top.symbol)}&side=${side}` : "/launch";

  return (
    <Link
      href={href}
      className="group relative flex h-full min-h-[260px] flex-col justify-between overflow-hidden rounded-[18px] border-2 border-dashed border-line-2 p-5 transition-colors hover:border-brand hover:bg-brand-soft/40"
    >
      <div aria-hidden className="pointer-events-none absolute -right-16 -bottom-16 text-brand/15 transition-colors group-hover:text-brand/30">
        <Guilloche teeth={27} reach={0.9} rings={4} size={260} spin={80} />
      </div>
      <span className="flex size-11 items-center justify-center rounded-full bg-brand text-white transition-transform group-hover:rotate-90">
        <Plus size={20} aria-hidden />
      </span>
      <div className="relative">
        <div className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">Your coin here</div>
        {top ? (
          <p className="mt-1.5 text-sm text-ink-2">
            <span className="inline-flex items-center gap-1 align-middle">
              <AssetIcon symbol={top.symbol} size={14} />
              {top.symbol}
            </span>{" "}
            is {fmtChange(top.change24h, 1)} today. Launch a {side} on it.
          </p>
        ) : (
          <p className="mt-1.5 text-sm text-ink-2">Pick an asset, a side and a leverage.</p>
        )}
      </div>
    </Link>
  );
}
