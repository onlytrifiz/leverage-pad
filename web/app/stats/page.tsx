import Link from "next/link";
import { listCoins, openPositions } from "@/lib/detail";
import { fmtUsd, fmtInt } from "@/lib/format";
import { DemoBadge } from "@/components/Badge";
import AutoRefresh from "@/components/AutoRefresh";

export const metadata = { title: "stats · multiply.cash" };
export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const [coins, positions] = await Promise.all([listCoins(), openPositions()]);
  const totalFees = coins.reduce((a, c) => a + c.feesCollectedUsd, 0);
  const totalBurned = coins.reduce((a, c) => a + c.burnedTokens, 0);
  const totalMcap = coins.reduce((a, c) => a + (c.marketCapUsd ?? 0), 0);
  const totalNotional = positions.reduce((a, p) => a + (p.notionalUsd ?? 0), 0);
  const totalPnl = positions.reduce((a, p) => a + (p.pnlUsd ?? 0), 0);
  const isDemo = coins.some((c) => c.demo);

  return (
    <div className="pt-8">
      <AutoRefresh everyMs={30_000} />
      <div className="flex items-center gap-3">
        <h1 className="text-[26px] font-bold tracking-tight">Protocol stats</h1>
        {isDemo && <DemoBadge />}
      </div>
      <p className="mt-2 max-w-[560px] text-[13px] leading-relaxed text-ink-2">
        Everything here is derived from the registry, the chain and Lighter — the same
        numbers you can reconstruct yourself from the explorer.
      </p>

      <div className="panel mt-6 grid grid-cols-2 gap-px overflow-hidden bg-line/50 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "coins launched", value: String(coins.length) },
          { label: "combined mcap", value: fmtUsd(totalMcap) },
          { label: "fees collected", value: fmtUsd(totalFees) },
          { label: "tokens burned", value: fmtInt(totalBurned) },
          { label: "open notional", value: fmtUsd(totalNotional) },
          {
            label: "unrealized pnl",
            value: (totalPnl >= 0 ? "+" : "−") + fmtUsd(Math.abs(totalPnl)),
            tone: totalPnl >= 0 ? "text-up-bright" : "text-down-bright",
          },
        ].map((s) => (
          <div key={s.label} className="bg-panel px-4 py-4">
            <div className="lbl mb-1.5">{s.label}</div>
            <div className={`num text-[18px] font-semibold ${s.tone ?? ""}`}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr] gap-3 px-4 py-2">
            {["coin", "underlying", "mcap", "fees", "burned", "engine"].map((h) => (
              <span key={h} className="lbl">{h}</span>
            ))}
          </div>
          <div className="space-y-1.5">
            {coins.map(({ coin, marketCapUsd, feesCollectedUsd, burnedTokens, perpOpen }) => (
              <Link
                key={coin.token}
                href={`/token/${coin.token}`}
                className="panel grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr] items-center gap-3 px-4 py-3 transition-all hover:border-accent/40"
              >
                <span className="text-[13px] font-bold">${coin.symbol}</span>
                <span className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${coin.side === "long" ? "text-up-bright" : "text-down-bright"}`}>
                  {coin.leverage}x {coin.side} {coin.market}
                </span>
                <span className="num text-[12px]">{fmtUsd(marketCapUsd)}</span>
                <span className="num text-[12px]">{fmtUsd(feesCollectedUsd)}</span>
                <span className="num text-[12px] text-accent-bright">{fmtInt(burnedTokens)}</span>
                <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${perpOpen ? "text-accent-bright" : "text-ink-3"}`}>
                  {perpOpen ? "● perp live" : "accumulating"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
