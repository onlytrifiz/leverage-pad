"use client";

import Link from "next/link";
import { cn } from "cn";
import type { CoinListItem } from "@/lib/types";
import { fmtChange, fmtInt, fmtSignedUsd, fmtUsd } from "@/lib/format";
import { OPEN_GATE_USD, fmtThreshold } from "@/lib/thresholds";
import { useMarkets } from "@/components/markets-provider";
import { CoinSeal } from "@/components/brand/CoinSeal";
import AssetIcon from "@/components/AssetIcon";
import { LivePulse } from "@/components/motion";

/**
 * One coin in the market grid, cut from the same paper as its banknote.
 *
 * What a buyer scans for, in that order: how far it has come since launch, what
 * its fees are trading and how that asset is doing today, then size (market
 * cap, burned) and the engine's state. A live engine shows its P&L; one still
 * accumulating shows how close the fees are to opening it.
 *
 * The lamp under the cursor is two CSS variables written on pointer move, so
 * hovering a grid of cards never re-renders React.
 */
export default function CoinCard({ item, pnlUsd }: { item: CoinListItem; pnlUsd: number | null }) {
  const { coin } = item;
  const { markets } = useMarkets();
  const live = markets.find((m) => m.symbol === coin.market);
  const sinceLaunch =
    item.marketCapUsd != null && coin.openingMcapUsd > 0 ? (item.marketCapUsd / coin.openingMcapUsd - 1) * 100 : null;
  // fees collected against the gate: the same figure the coin page's engine ring shows
  const reserve = item.feesCollectedUsd;
  const gatePct = Math.max(0, Math.min(1, reserve / OPEN_GATE_USD));

  const onMove = (e: React.PointerEvent<HTMLAnchorElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  return (
    <Link
      href={`/token/${coin.token}`}
      onPointerMove={onMove}
      className="coin-card group relative block overflow-hidden rounded-[18px] border border-line-2 p-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_30px_60px_-30px_rgba(12,52,32,0.5)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="relative -m-1 shrink-0">
          <CoinSeal leverage={coin.leverage} side={coin.side} takeProfitPct={coin.takeProfitPct} size={64} rings={3} spin={60} className="text-brand" />
        </div>
        <div className="min-w-0 text-right">
          <div className={cn("num text-2xl font-semibold", sinceLaunch == null ? "text-ink" : sinceLaunch >= 0 ? "text-up" : "text-down")}>
            {fmtChange(sinceLaunch, 1)}
          </div>
          <div className="text-2xs text-ink-3">since launch</div>
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <h3 className="truncate font-display text-2xl leading-none font-bold tracking-[-0.02em] text-ink">${coin.symbol}</h3>
        {item.demo && <span className="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-2xs text-ink-3">demo</span>}
      </div>
      <p className="mt-1 truncate text-sm text-ink-3">{coin.name}</p>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1 font-medium text-brand">
          <AssetIcon symbol={coin.market} size={15} />
          {coin.leverage}x {coin.side} {coin.market}
        </span>
        {live?.change24h != null && (
          <span className={cn("num text-xs", live.change24h >= 0 ? "text-up" : "text-down")}>
            {coin.market} {fmtChange(live.change24h, 1)} today
          </span>
        )}
      </div>

      <div className="rule-engraved mt-5" />

      <dl className="mt-4 grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <dt className="text-2xs text-ink-3">Market cap</dt>
          <dd className="num mt-0.5 truncate text-sm font-semibold text-ink">{fmtUsd(item.marketCapUsd)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-2xs text-ink-3">Burned</dt>
          <dd className="num mt-0.5 truncate text-sm font-semibold text-ink">{fmtInt(item.burnedTokens)}</dd>
        </div>
        <div className="min-w-0 text-right">
          <dt className="text-2xs text-ink-3">Engine</dt>
          {item.perpOpen ? (
            <dd className={cn("num mt-0.5 flex items-center justify-end gap-1.5 truncate text-sm font-semibold", (pnlUsd ?? 0) >= 0 ? "text-up" : "text-down")}>
              <LivePulse tone="brand" />
              {pnlUsd == null ? "live" : fmtSignedUsd(pnlUsd)}
            </dd>
          ) : (
            <dd className="mt-1.5">
              <span className="block h-1.5 overflow-hidden rounded-full bg-panel-2" title={`${fmtUsd(reserve)} of ${fmtThreshold(OPEN_GATE_USD)}`}>
                <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(4, gatePct * 100)}%` }} />
              </span>
              <span className="num mt-1 block text-2xs text-ink-3">{Math.round(gatePct * 100)}% to open</span>
            </dd>
          )}
        </div>
      </dl>
    </Link>
  );
}
