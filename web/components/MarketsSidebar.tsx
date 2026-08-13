"use client";

import { useEffect, useState } from "react";
import type { MarketRow } from "@/lib/lighter";
import AssetIcon from "./AssetIcon";

/** i 39 perp di Lighter, ordinati per volume: cosa puoi mettere sotto una coin */
export default function MarketsSidebar() {
  const [rows, setRows] = useState<MarketRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/markets")
        .then((r) => r.json())
        .then((j) => alive && setRows(j.markets ?? []))
        .catch(() => alive && setRows([]));
    load();
    const id = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="lbl">markets</span>
        <span className="lbl flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-bright" />
          lighter
        </span>
      </div>
      <div className="max-h-[640px] overflow-y-auto p-1.5">
        {rows == null && <div className="lbl px-3 py-5">loading markets…</div>}
        {rows?.map((m) => (
          <div key={m.marketId} className="flex items-center justify-between gap-2 rounded px-2.5 py-2 transition-colors hover:bg-panel-2">
            <span className="flex min-w-0 items-center gap-2 text-[12px] font-semibold text-ink">
              <AssetIcon symbol={m.symbol} size={18} />
              <span className="truncate">{m.symbol}</span>
            </span>
            <span className="text-right">
              <span className="num block text-[12px] text-ink-2">
                ${m.mark != null ? (m.mark >= 100 ? m.mark.toLocaleString("en-US", { maximumFractionDigits: 0 }) : m.mark.toPrecision(4)) : "—"}
              </span>
              {m.change24h != null && (
                <span className={`num block text-[10px] ${m.change24h >= 0 ? "text-up-bright" : "text-down-bright"}`}>
                  {m.change24h >= 0 ? "+" : ""}{m.change24h.toFixed(2)}%
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
