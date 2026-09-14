import { listCoins } from "@/lib/detail";
import { Container } from "@/components/ui/container";
import { StatGrid, Stat } from "@/components/ui/stat";
import { MarketsProvider } from "@/components/markets-provider";
import TickerTape from "@/components/TickerTape";
import MarketsSidebar from "@/components/MarketsSidebar";
import PositionsSidebar from "@/components/PositionsSidebar";
import CoinTable from "@/components/CoinTable";
import AutoRefresh from "@/components/AutoRefresh";
import Hero from "@/components/Hero";
import EngineStairs from "@/components/EngineStairs";

export const dynamic = "force-dynamic";

export default async function Home() {
  const coins = await listCoins();
  const totalFees = coins.reduce((a, c) => a + c.feesCollectedUsd, 0);
  const totalBurned = coins.reduce((a, c) => a + c.burnedTokens, 0);
  const liveEngines = coins.filter((c) => c.perpOpen).length;

  return (
    <MarketsProvider>
      <TickerTape />

      <Hero coins={coins.length} liveEngines={liveEngines} totalBurned={totalBurned} />

      {/* the engine, given its own room instead of being crammed into the hero */}
      <Container width="wide" className="pt-10">
        <div className="rule-engraved" />
        <div className="mt-5 max-w-[1040px]">
          <h2 className="text-2xl font-semibold">How a coin funds its own position</h2>
          <EngineStairs />
        </div>
      </Container>

      <Container
        width="wide"
        className="grid min-h-[calc(100dvh-var(--header-h))] grid-cols-1 gap-6 pt-6 lg:grid-cols-[236px_minmax(0,1fr)] xl:grid-cols-[236px_minmax(0,1fr)_300px]"
      >
        {/* left: the Lighter markets */}
        <aside className="hidden lg:block">
          <MarketsSidebar />
        </aside>

        {/* centre: aggregates and the coin table */}
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Protocol to date</h2>
            <AutoRefresh everyMs={30_000} />
          </div>
          <StatGrid>
            <Stat label="Coins launched" amount={coins.length} format="plain" countOnMount />
            <Stat label="Engines live" amount={liveEngines} format="plain" countOnMount />
            <Stat label="Fees collected" amount={totalFees} format="usd" countOnMount />
            <Stat label="Tokens burned" amount={totalBurned} format="int" countOnMount tone="brand" />
          </StatGrid>

          <div className="mt-8">
            <CoinTable items={coins} />
          </div>
        </div>

        {/* right: open perp positions */}
        <aside className="hidden xl:block">
          <PositionsSidebar />
        </aside>
      </Container>
    </MarketsProvider>
  );
}
