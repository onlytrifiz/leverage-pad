import { listCoins } from "@/lib/detail";
import { fmtUsd, fmtInt } from "@/lib/format";
import TickerTape from "@/components/TickerTape";
import MarketsSidebar from "@/components/MarketsSidebar";
import PositionsSidebar from "@/components/PositionsSidebar";
import CoinTable from "@/components/CoinTable";
import AutoRefresh from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

/** il motore in una riga: nodi + frecce animate (la firma della home) */
function EnginePipeline() {
  const node = (label: string, sub: string, hot = false) => (
    <div
      className={`shrink-0 rounded-md border px-2.5 py-1.5 text-center ${
        hot ? "border-accent/60 bg-accent-dim/30" : "border-line bg-panel"
      }`}
    >
      <div className={`text-[10px] font-bold uppercase tracking-[0.1em] ${hot ? "text-accent-bright" : "text-ink"}`}>
        {label}
      </div>
      <div className="lbl mt-0.5 normal-case tracking-normal">{sub}</div>
    </div>
  );
  return (
    <div className="mt-6 flex items-center gap-1.5 overflow-x-auto pb-2" aria-label="fee engine: trading fees fund a perp, profits buy back and burn">
      {node("trading fees", "1% every swap")}
      <div className="flow-arrow" aria-hidden />
      {node("perp on lighter", "100% of fees", true)}
      <div className="flow-arrow" aria-hidden />
      {node("profits return", "75% buyback")}
      <div className="flow-arrow" aria-hidden />
      {node("buyback & burn", "supply ↓", true)}
    </div>
  );
}

export default async function Home() {
  const coins = await listCoins();
  const totalFees = coins.reduce((a, c) => a + c.feesCollectedUsd, 0);
  const totalBurned = coins.reduce((a, c) => a + c.burnedTokens, 0);
  const liveEngines = coins.filter((c) => c.perpOpen).length;

  return (
    <>
      <AutoRefresh everyMs={30_000} />
      <div className="-mx-4">
        <TickerTape />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[230px_1fr] xl:grid-cols-[230px_1fr_290px]">
        {/* sinistra: i mercati Lighter */}
        <aside className="hidden lg:block">
          <MarketsSidebar />
        </aside>

        {/* centro: hero + stats + tabella */}
        <div className="min-w-0">
          <div className="panel relative overflow-hidden px-6 py-7">
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: "radial-gradient(420px 200px at 85% 0%, rgba(0,200,5,0.10), transparent 65%)" }}
              aria-hidden
            />
            <div className="lbl mb-2 flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-bright" />
              robinhood chain · perp-backed
            </div>
            <h1 className="text-[30px] font-bold leading-tight tracking-tight">
              Coins that <span className="green-glow text-accent-bright">trade for their holders</span>.
            </h1>
            <p className="mt-3 max-w-[560px] text-[13px] leading-relaxed text-ink-2">
              Liquidity locked forever. A 1% fee on every swap funds a leveraged perp on
              Lighter — BTC, NVDA, TSLA, even <span className="text-ink">ANTHROPIC pre-IPO</span> —
              and the profits buy back and burn the coin. No admin keys. Verify everything on-chain.
            </p>
            <EnginePipeline />
          </div>

          {/* barra aggregati */}
          <div className="panel mt-4 grid grid-cols-2 gap-px overflow-hidden bg-line/50 sm:grid-cols-4">
            {[
              { label: "coins launched", value: String(coins.length) },
              { label: "engines live", value: String(liveEngines) },
              { label: "fees collected", value: fmtUsd(totalFees) },
              { label: "tokens burned", value: fmtInt(totalBurned) },
            ].map((s) => (
              <div key={s.label} className="bg-panel px-4 py-3">
                <div className="lbl mb-1">{s.label}</div>
                <div className="num text-[16px] font-semibold">{s.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <CoinTable items={coins} />
          </div>
        </div>

        {/* destra: posizioni perp aperte */}
        <aside className="hidden xl:block">
          <PositionsSidebar />
        </aside>
      </div>
    </>
  );
}
