import { ArrowRight, Clock, Undo2 } from "lucide-react";
import { cn } from "cn";
import type { Coin, EngineLogItem, EngineSettings } from "@/lib/types";
import { explorerTx } from "@/lib/clientConfig";
import { timeAgo } from "@/lib/format";
import AssetIcon from "@/components/AssetIcon";
import { Panel, PanelHeader, PanelTitle, PanelMeta } from "@/components/ui/panel";

/**
 * Every change of engine since launch, from the router's events, as from → to: green and up for a
 * long, red and down for a short. What never took effect is struck through. Absent when nothing
 * ever changed.
 */

type Row = { item: EngineLogItem; from: EngineSettings; to: EngineSettings | null; state: "live" | "past" | "waiting" | "dropped" | "withdrawn" };

/** the log read forward: each change starts from the engine the ones before it left */
function rowsOf(coin: Coin, now: number): Row[] {
  let cur = coin.launchEngine;
  let last: EngineSettings | null = null;
  const rows: Row[] = [];
  for (const item of [...coin.engineLog].reverse()) {
    if (!item.engine) {
      rows.push({ item, from: cur, to: last, state: "withdrawn" });
      continue;
    }
    const to = { ...cur, ...item.engine };
    const waiting = item.kind === "announced" && !item.dropped && (item.effectiveAt ?? 0) > now;
    last = to;
    rows.push({ item, from: cur, to, state: item.dropped ? "dropped" : waiting ? "waiting" : "past" });
    if (!item.dropped && !waiting) cur = to;
  }
  const live = [...rows].reverse().find((r) => r.state === "past");
  if (live) live.state = "live";
  return rows.reverse();
}

const LABEL: Record<Row["state"], string> = { live: "Now", past: "", waiting: "Announced", dropped: "Never in effect", withdrawn: "Withdrawn" };

export default function EngineHistory({ coin, now }: { coin: Coin; now: number }) {
  if (!coin.engineLog.length) return null;
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Engine changes</PanelTitle>
        <PanelMeta>{coin.engineLog.length}</PanelMeta>
      </PanelHeader>
      <ol className="divide-y divide-line">
        {rowsOf(coin, now).map(({ item, from, to, state }) => {
          const off = state === "dropped" || state === "withdrawn";
          const retune = to && from.market === to.market && from.side === to.side && from.leverage === to.leverage;
          return (
            <li key={`${item.txHash}-${item.kind}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-5 py-2.5 text-sm">
              <span className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", off && "opacity-50")}>
                <Engine e={from} quiet />
                {to && (
                  <>
                    <ArrowRight size={14} aria-label="to" className="shrink-0 text-ink-3" />
                    {retune ? null : <Engine e={to} struck={off} />}
                    {(retune || from.takeProfitPct !== to.takeProfitPct) && (
                      <span className={cn("num text-xs text-ink-3", off && "line-through")}>take-profit +{to.takeProfitPct}%</span>
                    )}
                  </>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-ink-3">
                {state === "waiting" && <Clock size={13} aria-hidden className="text-brand" />}
                {state === "withdrawn" && <Undo2 size={13} aria-hidden />}
                <span className={cn(state === "waiting" && "font-medium text-brand", state === "live" && "font-medium text-ink")}>
                  {item.kind === "override" ? "Protocol override" : LABEL[state]}
                </span>
                <a href={explorerTx(item.txHash)} target="_blank" rel="noreferrer" className="hover:text-brand">
                  {timeAgo(item.ts, now)}
                </a>
              </span>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/** an engine in one line: the asset's mark, which way, how hard */
function Engine({ e, quiet = false, struck = false }: { e: EngineSettings; quiet?: boolean; struck?: boolean }) {
  const long = e.side === "long";
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", struck && "line-through")}>
      <AssetIcon symbol={e.market} size={18} />
      <span className="font-semibold text-ink">{e.market}</span>
      <span
        className={cn(
          "num rounded px-1.5 py-0.5 text-xs font-semibold",
          long ? "text-up" : "text-down",
          !quiet && (long ? "bg-[color-mix(in_oklch,var(--color-up),transparent_88%)]" : "bg-[color-mix(in_oklch,var(--color-down),transparent_90%)]")
        )}
      >
        <span aria-hidden>{long ? "↑" : "↓"}</span> {e.leverage}x {e.side}
      </span>
    </span>
  );
}
