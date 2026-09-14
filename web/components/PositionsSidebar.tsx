"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OpenPosition } from "@/lib/types";
import { useLivePositions } from "@/hooks/use-lighter-live";
import { useMarkets } from "./markets-provider";
import { fmtUsd, fmtChange } from "@/lib/format";
import { OPEN_GATE_LABEL } from "@/lib/thresholds";
import { Skeleton } from "@/components/ui/skeleton";
import { Reveal, RevealItem, AnimatedNumber } from "@/components/motion";
import AssetIcon from "./AssetIcon";
import { RailHead } from "./MarketsSidebar";

/**
 * Perp positions the coins' engines currently hold, read from Lighter.
 *
 * Two sources, each where it is cheapest. The list is polled: it answers "which
 * coins have a position open", which changes at the pace of the keeper. Size,
 * entry and margin come from each account's stream channel, which is all but
 * silent because it only speaks when the position actually changes. The mark is
 * the one the markets provider is already polling for the rail next door — this
 * rail opening its own price channel per row would pay twice for the same
 * number.
 */
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
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="rail">
      <RailHead title="Open perp positions" meta="Live" />
      <div className="rail-body">
        {rows == null &&
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 px-2 py-2.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        {rows?.length === 0 && (
          <p className="px-2 py-4 text-sm leading-relaxed text-ink-3">
            No open positions: engines open at the {OPEN_GATE_LABEL} gate.
          </p>
        )}
        <Reveal className="contents" trigger="mount">
        {rows?.map((p) => (
          <PositionRow key={p.token} row={p} />
        ))}
        </Reveal>
      </div>
    </div>
  );
}

/** una riga, agganciata al canale del conto che la riguarda */
function PositionRow({ row }: { row: OpenPosition }) {
  const all = useLivePositions(row.accountIndex);
  const { markets } = useMarkets();
  const live = row.marketId != null ? (all?.[row.marketId] ?? null) : null;

  // lo stream ha parlato e la posizione non c'e' piu': e' stata chiusa davvero,
  // la riga sparisce senza aspettare il prossimo giro di polling
  if (all != null && row.marketId != null && !live) return null;

  const mark = markets.find((m) => m.marketId === row.marketId)?.mark ?? null;
  const notionalUsd =
    live && mark != null ? mark * live.size : (live?.positionValueUsd ?? row.notionalUsd);
  const collateralUsd = live?.allocatedMarginUsd ?? row.collateralUsd;
  const pnlUsd =
    live && mark != null && live.entryPrice != null
      ? live.sign * (mark - live.entryPrice) * live.size
      : (live?.unrealizedPnlUsd ?? row.pnlUsd);
  const p = {
    ...row,
    notionalUsd,
    collateralUsd,
    pnlUsd,
    pnlPct:
      pnlUsd != null && collateralUsd ? (pnlUsd / collateralUsd) * 100 : row.pnlPct,
  };

  return (
    <RevealItem>
    <Link
      href={`/token/${p.token}`}
      className="block min-w-0 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-md font-semibold text-ink">${p.symbol}</span>
        {p.pnlUsd != null && (
          <span
            className={`num shrink-0 text-sm font-semibold ${p.pnlUsd >= 0 ? "text-up" : "text-down"}`}
          >
            <AnimatedNumber value={p.pnlUsd} format="signedUsd" />
          </span>
        )}
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
        <span
          className={`flex min-w-0 items-center gap-1.5 text-xs ${p.side === "long" ? "text-up" : "text-down"}`}
        >
          <AssetIcon symbol={p.market} size={16} />
          <span className="truncate">
            {p.leverage}× {p.side} {p.market}
          </span>
        </span>
        {p.pnlPct != null && (
          <span
            className={`num shrink-0 text-xs ${p.pnlPct >= 0 ? "text-up" : "text-down"}`}
          >
            {fmtChange(p.pnlPct, 1)}
          </span>
        )}
      </div>
      <div className="num mt-1 truncate text-xs text-ink-3">
        {fmtUsd(p.notionalUsd)} · coll {fmtUsd(p.collateralUsd)} ·{" "}
        {p.ageDays === 0 ? "today" : `${p.ageDays}d`}
      </div>
    </Link>
    </RevealItem>
  );
}
