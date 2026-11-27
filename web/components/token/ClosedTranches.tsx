import { History } from "lucide-react";
import type { ClosedTranche, CoinDetail } from "@/lib/types";
import { fmtMark, fmtSignedUsd, fmtUsd, timeAgo } from "@/lib/format";
import { PROFIT_SPLIT_PCT } from "@/lib/doppler";
import { Badge } from "@/components/ui/badge";
import { Panel, PanelHeader, PanelTitle, PanelMeta } from "@/components/ui/panel";

/**
 * The tranches that are over, newest first: how each one ended and what it made or lost. A
 * take-profit banked its gain into the buyback; a liquidation lost the margin the tranche held.
 * Absent until the first tranche closes.
 */

const SHOWN = 6;

const OUTCOME: Record<ClosedTranche["outcome"], { label: string; variant: "brand" | "down" | "secondary" }> = {
  tp: { label: "Took profit", variant: "brand" },
  liquidated: { label: "Liquidated", variant: "down" },
  switched: { label: "Closed on a switch", variant: "secondary" },
  retired: { label: "Closed at retirement", variant: "secondary" },
};

const fmtSize = (v: number) => (v >= 1 ? v.toFixed(3) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(3));

function Row({ c, now }: { c: ClosedTranche; now: number }) {
  const o = OUTCOME[c.outcome] ?? OUTCOME.switched;
  const pct = c.collateralUsd > 0 ? (c.pnlUsd / c.collateralUsd) * 100 : null;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5 rounded-lg px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant={o.variant}>{o.label}</Badge>
        <span className="num text-sm font-medium text-ink">
          {fmtSize(c.size)} {c.market}
        </span>
        <span className="num text-xs text-ink-3">
          {fmtMark(c.entry)} → <span className="text-ink-2">{c.exit != null ? fmtMark(c.exit) : "—"}</span>
        </span>
      </div>
      <div className="flex items-baseline gap-3 text-xs text-ink-3">
        <span className={`num text-sm font-medium ${c.pnlUsd >= 0 ? "text-brand" : "text-down"}`}>
          {fmtSignedUsd(c.pnlUsd)}
          {pct != null && <span className="ml-1 text-xs font-normal opacity-80">({pct >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(0)}%)</span>}
        </span>
        <span>{timeAgo(Math.floor(c.closedAt / 1000), now)}</span>
      </div>
    </li>
  );
}

export function closedTotals(closed: ClosedTranche[]) {
  const won = closed.filter((c) => c.pnlUsd >= 0), lost = closed.filter((c) => c.pnlUsd < 0);
  return {
    count: closed.length,
    banked: won.reduce((a, c) => a + c.pnlUsd, 0),
    lost: -lost.reduce((a, c) => a + c.pnlUsd, 0),
    tookProfit: closed.filter((c) => c.outcome === "tp").length,
    liquidated: closed.filter((c) => c.outcome === "liquidated").length,
  };
}

export default function ClosedTranches({ detail }: { detail: CoinDetail }) {
  const { closed } = detail;
  if (!closed.length) return null;
  const now = detail.stats.updatedAt;
  const t = closedTotals(closed);
  const rest = closed.slice(SHOWN);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle className="flex items-center gap-2">
          <History aria-hidden size={16} className="text-brand" />
          Closed tranches
        </PanelTitle>
        <PanelMeta>
          {t.count} closed
        </PanelMeta>
      </PanelHeader>
      <dl className="grid grid-cols-2 gap-px border-b border-border bg-border">
        <div className="min-w-0 bg-panel px-4 py-3 sm:px-5">
          <dt className="text-xs text-ink-3">Took profit · {t.tookProfit}</dt>
          <dd className="num mt-1 text-lg font-semibold text-brand">{fmtSignedUsd(t.banked)}</dd>
        </div>
        <div className="min-w-0 bg-panel px-4 py-3 sm:px-5">
          <dt className="text-xs text-ink-3">Liquidated · {t.liquidated}</dt>
          <dd className={`num mt-1 text-lg font-semibold ${t.lost > 0 ? "text-down" : "text-ink-2"}`}>
            {t.lost > 0 ? `−${fmtUsd(t.lost)}` : fmtUsd(0)}
          </dd>
        </div>
      </dl>
      <ul className="flex flex-col gap-1 p-2.5">
        {closed.slice(0, SHOWN).map((c, i) => (
          <Row key={`${c.openedAt}-${c.closedAt}-${i}`} c={c} now={now} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="group border-t border-border">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm text-ink-2 hover:text-ink sm:px-5 [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show {rest.length} older</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="flex flex-col gap-1 px-2.5 pb-2.5">
            {rest.map((c, i) => (
              <Row key={`${c.openedAt}-${c.closedAt}-${i}`} c={c} now={now} />
            ))}
          </ul>
        </details>
      )}
      <p className="border-t border-border px-4 py-3 text-xs leading-relaxed text-ink-3 sm:px-5">
        A tranche that reaches its take-profit buys the token back with its capital and {PROFIT_SPLIT_PCT.buyback}% of the gain.
        One that is liquidated loses the margin it held, and nothing more: the engine never sells the token.
      </p>
    </Panel>
  );
}
