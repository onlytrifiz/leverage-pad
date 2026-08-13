import type { CoinDetail } from "@/lib/types";
import { fmtUsd } from "@/lib/format";
import AssetIcon from "./AssetIcon";

/**
 * La gamba perp su Lighter: la card e' l'unico elemento con bordo accent pieno —
 * e' il motore che distingue il prodotto da un normale meme-launchpad.
 */
export default function HedgeCard({ detail }: { detail: CoinDetail }) {
  const { coin, perp, stats } = detail;
  const pnl = perp?.unrealizedPnlUsd ?? null;
  const pnlTone = pnl == null ? "text-ink" : pnl >= 0 ? "text-up-bright" : "text-down-bright";

  const cells: { label: string; value: string; tone?: string }[] = perp?.open
    ? [
        { label: "collateral", value: fmtUsd(perp.collateralUsd) },
        { label: "position size", value: fmtUsd(perp.positionSizeUsd) },
        { label: "leverage", value: `${coin.leverage}x` },
        { label: "entry price", value: fmtUsd(perp.entryPrice) },
        { label: "mark price", value: fmtUsd(perp.markPrice) },
        { label: "unrealized pnl", value: (pnl != null && pnl >= 0 ? "+" : "") + fmtUsd(pnl), tone: pnlTone },
      ]
    : [
        { label: "perp reserve", value: fmtUsd(stats.perpReserveUsd) },
        { label: "open gate", value: "$20.00" },
        { label: "leverage", value: `${coin.leverage}x` },
        { label: "market", value: coin.market },
      ];

  return (
    <div className="rounded-md border border-accent/60 bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-accent/30 px-4 py-2.5">
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-bright">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${perp?.open ? "animate-pulse bg-accent-bright" : "bg-ink-3"}`} />
          perp hedge · {coin.side} {coin.market} {coin.leverage}x
          <AssetIcon symbol={coin.market} size={16} />
        </span>
        <span className="lbl flex items-center gap-2">
          {coin.riskProfile && (
            <span className="rounded border border-line-2 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">
              {coin.riskProfile}
            </span>
          )}
          {perp?.open ? "live on lighter" : `opens when reserve ≥ $20 (now ${fmtUsd(stats.perpReserveUsd)})`}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-line/50 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="bg-panel px-4 py-3">
            <div className="lbl mb-1">{c.label}</div>
            <div className={`num text-[15px] font-semibold ${c.tone ?? "text-ink"}`}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
