"use client";

import { useEffect, useState } from "react";
import type { MarketRow } from "@/lib/lighter";
import AssetIcon from "./AssetIcon";

/**
 * Nastro prezzi dei perp Lighter che scorre sotto la nav — il battito
 * del venue su cui girano le posizioni. Pausa in hover, fermo con
 * prefers-reduced-motion (resta leggibile come lista statica).
 */
export default function TickerTape() {
  const [rows, setRows] = useState<MarketRow[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/markets")
        .then((r) => r.json())
        .then((j) => alive && setRows((j.markets ?? []).slice(0, 24)))
        .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!rows.length) return <div className="h-9 border-b border-line" />;

  const cell = (m: MarketRow, i: number) => (
    <span key={i} className="mx-4 inline-flex items-center gap-1.5 text-[11px]">
      <AssetIcon symbol={m.symbol} size={14} />
      <span className="font-semibold text-ink">{m.symbol}</span>
      <span className="num text-ink-2">
        ${m.mark != null ? (m.mark >= 100 ? m.mark.toLocaleString("en-US", { maximumFractionDigits: 0 }) : m.mark.toPrecision(4)) : "—"}
      </span>
      {m.change24h != null && (
        <span className={`num ${m.change24h >= 0 ? "text-up-bright" : "text-down-bright"}`}>
          {m.change24h >= 0 ? "+" : ""}{m.change24h.toFixed(2)}%
        </span>
      )}
    </span>
  );

  return (
    <div className="group relative overflow-hidden border-b border-line bg-panel/60">
      <div className="flex w-max animate-[tape_60s_linear_infinite] py-2 group-hover:[animation-play-state:paused] motion-reduce:w-full motion-reduce:animate-none motion-reduce:overflow-x-auto">
        {rows.map(cell)}
        {rows.map((m, i) => cell(m, i + rows.length))}
      </div>
    </div>
  );
}
