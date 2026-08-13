"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { CoinListItem } from "@/lib/types";
import { fmtUsd, fmtInt } from "@/lib/format";
import { DemoBadge } from "./Badge";
import AssetIcon from "./AssetIcon";

/**
 * Tabella coin con tab e ricerca. "Stock-backed" = sottostante non-crypto
 * (l'angolo distintivo su Robinhood Chain: NVDA, TSLA, ANTHROPIC…).
 */

const CRYPTO_MARKETS = new Set(["BTC", "ETH", "SOL", "HYPE", "ZEC", "DOGE", "XRP", "SUI", "LINK", "AVAX"]);

type Tab = "all" | "stock" | "crypto" | "shorts" | "new";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "all coins" },
  { key: "stock", label: "stock-backed" },
  { key: "crypto", label: "crypto-backed" },
  { key: "shorts", label: "shorts" },
  { key: "new", label: "new" },
];

export default function CoinTable({ items }: { items: CoinListItem[] }) {
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(({ coin }) => {
      if (tab === "stock" && CRYPTO_MARKETS.has(coin.market)) return false;
      if (tab === "crypto" && !CRYPTO_MARKETS.has(coin.market)) return false;
      if (tab === "shorts" && coin.side !== "short") return false;
      if (tab === "new" && Date.now() - new Date(coin.createdAt).getTime() > 3 * 86_400_000) return false;
      if (needle)
        return (
          coin.symbol.toLowerCase().includes(needle) ||
          coin.name.toLowerCase().includes(needle) ||
          coin.market.toLowerCase().includes(needle) ||
          coin.token.toLowerCase() === needle
        );
      return true;
    });
  }, [items, tab, q]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
                tab === t.key
                  ? "bg-accent-dim/50 text-accent-bright shadow-[inset_0_0_0_1px_rgba(0,200,5,0.4)]"
                  : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search ticker, name or market"
          className="w-full max-w-[260px] rounded border border-line bg-panel px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
        />
      </div>

      <div className="mt-3 overflow-x-auto">
        <div className="min-w-[600px]">
          <div className="grid grid-cols-[1.5fr_1.1fr_0.9fr_0.8fr_0.7fr] gap-2 px-4 py-2">
            {["coin", "underlying", "engine", "burned", "mcap"].map((h) => (
              <span key={h} className={`lbl ${h === "burned" || h === "mcap" ? "text-right" : ""}`}>{h}</span>
            ))}
          </div>
          <div className="space-y-1.5">
            {filtered.length === 0 && (
              <div className="panel px-4 py-8 text-center text-[12px] text-ink-3">
                Nothing matches — clear the search or switch tab.
              </div>
            )}
            {filtered.map(({ coin, marketCapUsd, burnedTokens, perpOpen, demo }) => (
              <Link
                key={coin.token}
                href={`/token/${coin.token}`}
                className="panel grid grid-cols-[1.5fr_1.1fr_0.9fr_0.8fr_0.7fr] items-center gap-2 px-4 py-3 transition-all hover:border-accent/40 hover:shadow-[0_0_24px_rgba(0,200,5,0.08)]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-bold">${coin.symbol}</span>
                    {demo && <DemoBadge />}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-3">{coin.name}</div>
                </div>
                <span className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] ${coin.side === "long" ? "text-up-bright" : "text-down-bright"}`}>
                  <AssetIcon symbol={coin.market} size={18} />
                  {coin.leverage}x {coin.side} {coin.market}
                </span>
                {perpOpen ? (
                  <span className="inline-flex w-fit items-center gap-1.5 rounded border border-accent/40 bg-accent-dim/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-accent-bright">
                    <span className="inline-block h-1 w-1 rounded-full bg-accent-bright" />
                    perp live
                  </span>
                ) : (
                  <span className="inline-flex w-fit items-center rounded border border-line-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3">
                    accumulating
                  </span>
                )}
                <span className="num text-right text-[12px] text-accent-bright">{fmtInt(burnedTokens)}</span>
                <span className="num text-right text-[13px] font-semibold">{fmtUsd(marketCapUsd)}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
