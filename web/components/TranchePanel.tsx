import type { CoinDetail } from "@/lib/types";
import { fmtUsd } from "@/lib/format";
import { timeAgo } from "@/lib/format";

/**
 * La ladder delle tranche: ogni deposito del motore corre verso il SUO target
 * (entry × trigger/leva). Le barre che si riempiono spiegano a colpo d'occhio
 * perche' il take-profit non e' ancora scattato — o quanto manca.
 */

const fmtMark = (v: number) =>
  "$" + (v >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toPrecision(4));

export default function TranchePanel({ detail }: { detail: CoinDetail }) {
  const { tranches, coin } = detail;
  if (!tranches.length) return null;
  const trigger = tranches[0].neededPct * coin.leverage;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="lbl">tranches · take-profit ladder</span>
        <span className="lbl">
          each banks fully at +{trigger.toFixed(0)}% ({coin.riskProfile ?? "balanced"})
        </span>
      </div>
      <div className="space-y-1 p-2">
        {tranches.map((t, i) => {
          const ripe = t.progress >= 1;
          return (
            <div key={i} className={`rounded px-2.5 py-2 ${ripe ? "border-l-2 border-accent bg-accent-dim/25" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex items-baseline gap-3">
                  <span className="lbl normal-case tracking-normal">#{tranches.length - i}</span>
                  <span className="num text-[12px] text-ink">{t.sizeText}</span>
                  <span className="num text-[11px] text-ink-3">
                    {fmtMark(t.entryMark)} → <span className="text-ink-2">{fmtMark(t.targetMark)}</span>
                  </span>
                  {t.synthetic && (
                    <span className="rounded border border-line-2 px-1 text-[9px] uppercase tracking-[0.1em] text-ink-3" title="ricostruita dalla riconciliazione con la size on-chain">
                      synth
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="lbl normal-case tracking-normal">coll {fmtUsd(t.collateralUsd)}</span>
                  <span className="lbl normal-case tracking-normal">{timeAgo(t.ts)}</span>
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-panel-2">
                  <div
                    className={`h-full rounded-full ${ripe ? "bg-accent-bright" : "bg-accent"}`}
                    style={{ width: `${Math.min(100, t.progress * 100)}%` }}
                  />
                </div>
                <span className={`num shrink-0 text-[11px] ${ripe ? "text-accent-bright" : t.movePct >= 0 ? "text-ink-2" : "text-down-bright"}`}>
                  {ripe ? "ripe — closing" : `${t.movePct >= 0 ? "+" : ""}${t.movePct.toFixed(1)}% / +${t.neededPct.toFixed(1)}%`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-line/50 px-4 py-2.5 text-[11px] leading-relaxed text-ink-3">
        One netted position on Lighter; each deposit is tracked as its own tranche with its
        own entry. New fees never dilute an old tranche&apos;s progress.
      </p>
    </div>
  );
}
