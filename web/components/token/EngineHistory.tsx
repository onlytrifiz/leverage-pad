import type { Coin } from "@/lib/types";
import { explorerTx } from "@/lib/clientConfig";
import { timeAgo } from "@/lib/format";
import { Panel, PanelHeader, PanelTitle, PanelMeta } from "@/components/ui/panel";

/**
 * Every change of engine since launch, from the router's events: what the creator announced,
 * took back, or the owner overrode. Absent when nothing ever changed.
 */
export default function EngineHistory({ coin, now }: { coin: Coin; now: number }) {
  if (!coin.engineLog.length) return null;
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Engine changes</PanelTitle>
        <PanelMeta>{coin.engineLog.length}</PanelMeta>
      </PanelHeader>
      <ol className="divide-y divide-line">
        {coin.engineLog.map((e) => {
          const x = e.engine;
          const text = !x
            ? "Announcement withdrawn"
            : [x.market && `${x.market} ${x.side}`, `${x.leverage}x`, `take-profit +${x.takeProfitPct}%`].filter(Boolean).join(", ");
          const status =
            e.kind === "override" ? "Protocol override" : e.kind === "withdrawn" ? "Creator" : e.effectiveAt && e.effectiveAt > now ? "Announced" : "Creator";
          return (
            <li key={`${e.txHash}-${e.kind}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-3 text-sm">
              <span className="min-w-0 text-ink">
                <span className="text-ink-3">{status}: </span>
                {text}
              </span>
              <a href={explorerTx(e.txHash)} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-ink-3 hover:text-brand">
                {timeAgo(e.ts, now)}
              </a>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
