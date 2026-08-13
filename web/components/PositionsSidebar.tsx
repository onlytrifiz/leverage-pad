"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OpenPosition } from "@/lib/types";
import { fmtUsd } from "@/lib/format";
import AssetIcon from "./AssetIcon";

/** le posizioni perp aperte dai motori delle coin, lette da Lighter */
export default function PositionsSidebar() {
  const [rows, setRows] = useState<OpenPosition[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/positions")
        .then((r) => r.json())
        .then((j) => alive && setRows(j.positions ?? []))
        .catch(() => alive && setRows([]));
    load();
    const id = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="lbl">open perp positions</span>
        <span className="lbl flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-bright" />
          live
        </span>
      </div>
      <div className="max-h-[640px] overflow-y-auto p-1.5">
        {rows == null && <div className="lbl px-3 py-5">reading lighter accounts…</div>}
        {rows != null && rows.length === 0 && (
          <div className="lbl px-3 py-5">no open positions — engines open at the $20 gate</div>
        )}
        {rows?.map((p) => (
          <Link
            key={p.token}
            href={`/token/${p.token}`}
            className="block rounded px-2.5 py-2.5 transition-colors hover:bg-panel-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-bold text-ink">${p.symbol}</span>
              <span className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${p.side === "long" ? "text-up-bright" : "text-down-bright"}`}>
                <AssetIcon symbol={p.market} size={14} />
                {p.leverage}x {p.side} {p.market}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="num text-[11px] text-ink-2">
                {fmtUsd(p.notionalUsd)} <span className="text-ink-3">coll {fmtUsd(p.collateralUsd)}</span>
              </span>
              {p.pnlUsd != null && (
                <span className={`num text-[11px] ${p.pnlUsd >= 0 ? "text-up-bright" : "text-down-bright"}`}>
                  {p.pnlUsd >= 0 ? "+" : "−"}{fmtUsd(Math.abs(p.pnlUsd))}
                  {p.pnlPct != null && ` (${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%)`}
                </span>
              )}
            </div>
            <div className="lbl mt-1 normal-case tracking-normal">
              {p.ageDays === 0 ? "opened today" : `${p.ageDays}d old`}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
