import { cn } from "cn";
import { liqDistancePct } from "@/lib/doppler";
import { fmtMove } from "@/lib/format";

/**
 * Why the liquidation is nearer than 100 / leverage, and what moving the leverage does to it, with
 * the venue's own numbers for the chosen market.
 */
export default function LiquidationNote({
  market,
  leverage,
  leverages,
  maintenancePct,
  up,
  takeProfitPct,
}: {
  market: string;
  leverage: number;
  /** the stops this market allows */
  leverages: readonly number[];
  maintenancePct: number;
  up: boolean;
  takeProfitPct: number;
}) {
  const away = liqDistancePct(leverage, maintenancePct);
  const need = takeProfitPct / leverage;
  const rows = leverages.map((l) => ({ l, d: liqDistancePct(l, maintenancePct) }));
  const widest = Math.max(...rows.map((r) => r.d));
  return (
    <div className="mt-3 rounded-[14px] border border-line bg-panel px-4 py-4">
      <h3 className="text-sm font-semibold text-ink">
        Liquidation is <span className="num text-down">{fmtMove(away)}</span> {up ? "below" : "above"} entry
      </h3>
      <p className="mt-1.5 max-w-[62ch] text-xs leading-relaxed text-ink-2">
        At {leverage}x the fees cover <span className="num">{fmtMove(100 / leverage)}</span> of the position. Lighter does not wait for
        them to run out: it closes when only <span className="num">{fmtMove(maintenancePct)}</span> is left on {market}, and its fee can take
        most of that. So <span className="num">{fmtMove(100 / leverage)}</span> − <span className="num">{fmtMove(maintenancePct)}</span> ={" "}
        <span className="num font-semibold text-ink">{fmtMove(away)}</span>. Less leverage, much more room:
      </p>
      <dl className="mt-3 space-y-1.5">
        {rows.map(({ l, d }) => (
          <div key={l} className="grid grid-cols-[34px_minmax(0,1fr)_48px] items-center gap-2 text-xs">
            <dt className={cn("num", l === leverage ? "font-semibold text-ink" : "text-ink-3")}>{l}x</dt>
            <div className="h-1.5 rounded-full bg-panel-2">
              <div className={cn("h-full min-w-[2px] rounded-full", l === leverage ? "bg-down" : "bg-line-2")} style={{ width: `${(d / widest) * 100}%` }} />
            </div>
            <dd className={cn("num text-right", l === leverage ? "font-semibold text-ink" : "text-ink-3")}>{fmtMove(d)}</dd>
          </div>
        ))}
      </dl>
      {away < need && (
        <p className="mt-3 text-xs leading-relaxed text-down">
          The liquidation ({fmtMove(away)}) is nearer than the take-profit ({fmtMove(need)}): {market} reaches the loss first more often than
          the profit.
        </p>
      )}
    </div>
  );
}
