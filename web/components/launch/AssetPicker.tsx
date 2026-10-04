"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "cn";
import type { MarketRow } from "@/lib/lighter";
import { fmtChange, fmtMark } from "@/lib/format";
import AssetIcon from "@/components/AssetIcon";

/**
 * Picking what a coin's fees trade, without a scroll box inside the page.
 *
 * Fifty-odd markets used to sit in a 300px scroller: a list inside a list,
 * with the page and the box fighting over the wheel. Now they are sorted into
 * the families a person thinks in (stocks, crypto, commodities, pre-IPO), the
 * first twelve of a family are shown, and "Show all" opens
 * the rest in the page itself. The chosen market is always on screen.
 *
 * Families are a hand-kept list of Lighter's symbols; anything unknown, the
 * venue's new memecoins included, lands in crypto.
 */

type Family = "all" | "stocks" | "crypto" | "commodities" | "preipo";

const STOCKS = new Set([
  "SPY", "QQQ", "AAPL", "NVDA", "GOOGL", "MSFT", "AMZN", "AMD", "META", "TSLA", "INTC", "SKHY", "MU", "CRCL",
  "COIN", "SOXL", "PLTR", "TSM", "ORCL", "CRWV", "BABA", "BE", "IREN", "AMC", "SOFI", "SMCI", "USAR", "ASTS",
  "SGOV", "QBTS", "LUNR", "CLSK", "RGTI", "WULF", "SNDK", "NFLX", "HOOD", "MSTR", "SHEIN", "SPCX",
]);
const COMMODITIES = new Set(["XAU", "XAG", "SLV", "USO"]);
const PREIPO = new Set(["ANTHROPIC", "OPENAI"]);

function familyOf(m: MarketRow): Exclude<Family, "all"> {
  if (STOCKS.has(m.symbol)) return "stocks";
  if (COMMODITIES.has(m.symbol)) return "commodities";
  if (PREIPO.has(m.symbol)) return "preipo";
  return "crypto";
}

const FAMILIES: { key: Family; label: string }[] = [
  { key: "all", label: "All" },
  { key: "stocks", label: "Stocks" },
  { key: "crypto", label: "Crypto" },
  { key: "commodities", label: "Commodities" },
  { key: "preipo", label: "Pre-IPO" },
];

/** 12 fills whole rows at both 2 (phone) and 3 (desktop) columns */
const FIRST = 12;

export default function AssetPicker({
  markets,
  loaded,
  value,
  onPick,
  levCap,
}: {
  markets: MarketRow[];
  loaded: boolean;
  value: string;
  /** the highest leverage a launch accepts: the venue's max is shown capped to it */
  levCap: number;
  /** `side` is a hint from the movers row: the direction of today's move */
  onPick: (symbol: string, side?: "long" | "short") => void;
}) {
  const [family, setFamily] = useState<Family>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const counts = useMemo(() => {
    const c: Record<Family, number> = { all: markets.length, stocks: 0, crypto: 0, commodities: 0, preipo: 0 };
    for (const m of markets) c[familyOf(m)]++;
    return c;
  }, [markets]);

  // the two biggest risers (a long idea) and the two biggest fallers (a short one)
  const movers = useMemo(() => {
    const moved = markets.filter((m) => m.change24h != null);
    const up = moved.filter((m) => m.change24h! > 0).sort((a, b) => b.change24h! - a.change24h!).slice(0, 2);
    const down = moved.filter((m) => m.change24h! < 0).sort((a, b) => a.change24h! - b.change24h!).slice(0, 2);
    return [...up, ...down];
  }, [markets]);

  const { visible, hidden } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = markets.filter((m) => (needle ? m.symbol.toLowerCase().includes(needle) : family === "all" || familyOf(m) === family));
    if (needle || open || list.length <= FIRST) return { visible: list, hidden: 0 };
    const head = list.slice(0, FIRST);
    // the chosen market stays on screen even when it ranks below the fold
    const chosen = list.find((m) => m.symbol === value);
    if (chosen && !head.includes(chosen)) head[FIRST - 1] = chosen;
    return { visible: head, hidden: list.length - FIRST };
  }, [markets, family, q, open, value]);

  return (
    <div>
      {movers.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-3">Moving today</span>
          {movers.map((m) => (
            <button
              key={m.symbol}
              type="button"
              onClick={() => onPick(m.symbol, (m.change24h ?? 0) >= 0 ? "long" : "short")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                value === m.symbol ? "border-brand bg-brand-soft text-brand" : "border-line bg-panel text-ink-2 hover:border-line-2"
              )}
            >
              <AssetIcon symbol={m.symbol} size={14} />
              {m.symbol}
              <span className={cn("num", (m.change24h ?? 0) >= 0 ? "text-up" : "text-down")}>{fmtChange(m.change24h, 1)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex max-w-full min-w-0 gap-1 overflow-x-auto rounded-xl bg-panel-2 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {FAMILIES.filter((f) => f.key === "all" || counts[f.key] > 0).map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setFamily(f.key);
                setOpen(false);
                setQ("");
              }}
              aria-pressed={family === f.key && !q}
              className={cn(
                "relative shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                family === f.key && !q ? "text-ink" : "text-ink-3 hover:text-ink"
              )}
            >
              {family === f.key && !q && (
                <motion.span layoutId="asset-family" className="absolute inset-0 rounded-lg bg-panel shadow-sm" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
              )}
              <span className="relative">
                {f.label}
                <span className="num ml-1.5 text-xs text-ink-3">{counts[f.key]}</span>
              </span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto w-full min-w-0 sm:w-[220px]">
          <span className="sr-only">Search markets</span>
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search NVDA, BTC, gold…"
            className="h-9 w-full rounded-lg border border-line bg-panel pr-3 pl-9 text-sm text-ink placeholder:text-ink-3 focus:border-brand"
          />
        </label>
      </div>

      <div role="radiogroup" aria-label="Underlying market" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {!loaded && Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[62px] animate-pulse rounded-xl bg-panel-2" />)}
        {loaded && visible.length === 0 && <p className="col-span-full py-6 text-sm text-ink-3">No market matches “{q}”.</p>}
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((m) => {
            const on = value === m.symbol;
            return (
              <motion.button
                key={m.symbol}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.2 }}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onPick(m.symbol)}
                className={cn(
                  "flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  on ? "border-brand bg-brand-soft shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line bg-panel hover:border-line-2"
                )}
              >
                <AssetIcon symbol={m.symbol} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{m.symbol}</span>
                    {m.change24h != null && (
                      <span className={cn("num shrink-0 text-xs", m.change24h >= 0 ? "text-up" : "text-down")}>
                        {fmtChange(m.change24h, 1)}
                      </span>
                    )}
                  </span>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="num truncate text-2xs text-ink-3">{fmtMark(m.mark)}</span>
                    {m.maxLeverage != null && (
                      <span className="num shrink-0 text-2xs text-ink-3" title={`Lighter allows ${m.maxLeverage}x`}>
                        max {Math.min(m.maxLeverage, levCap)}x
                      </span>
                    )}
                  </span>
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>

      {(hidden > 0 || open) && !q && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline"
        >
          {open ? "Show fewer" : `Show all ${hidden + FIRST}`}
          <ChevronDown size={15} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}
