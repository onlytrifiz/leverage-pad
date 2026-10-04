import { listCoins, openPositions } from "@/lib/detail";
import { Container } from "@/components/ui/container";
import { MarketsProvider } from "@/components/markets-provider";
import TickerTape from "@/components/TickerTape";
import PositionsSidebar from "@/components/PositionsSidebar";
import AutoRefresh from "@/components/AutoRefresh";
import { AnimatedNumber } from "@/components/motion";
import MoversStrip from "@/components/market/MoversStrip";
import CoinsBoard from "@/components/market/CoinsBoard";
import { Guilloche } from "@/components/brand/Guilloche";

export const dynamic = "force-dynamic";
export const metadata = { title: "Market" };

/**
 * The market, as its own page: what is moving on Lighter today (the launch
 * ideas), then every coin as a board you can filter and sort, with the open
 * positions alongside on a wide screen.
 */
export default async function MarketPage() {
  const [coins, positions] = await Promise.all([listCoins(), openPositions().catch(() => [])]);
  const totalFees = coins.reduce((a, c) => a + c.feesCollectedUsd, 0);
  const totalBurned = coins.reduce((a, c) => a + c.burnedTokens, 0);
  const liveEngines = coins.filter((c) => c.perpOpen).length;
  const pnl = Object.fromEntries(positions.map((p) => [p.token.toLowerCase(), p.pnlUsd]));

  const stats = [
    { k: "Coins", v: <AnimatedNumber value={coins.length} format="plain" countOnMount /> },
    { k: "Engines live", v: <AnimatedNumber value={liveEngines} format="plain" countOnMount /> },
    { k: "Fees put to work", v: <AnimatedNumber value={totalFees} format="usd" countOnMount /> },
    { k: "Tokens burned", v: <AnimatedNumber value={totalBurned} format="int" countOnMount /> },
  ];

  return (
    <MarketsProvider>
      <section className="intro-night behind-nav relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]">
        <div aria-hidden className="pointer-events-none absolute top-[38%] right-[-10%] -z-10 text-mint/[0.12]">
          <Guilloche teeth={39} reach={0.85} rings={4} size={900} spin={150} className="w-[120vw] max-w-[900px]" />
        </div>
        <div className="mx-auto w-full max-w-[1680px] px-4 pt-10 pb-10 sm:px-5 sm:pt-14 sm:pb-12">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
            <div className="min-w-0">
              <h1 className="font-display text-[clamp(44px,6vw,84px)] leading-[0.95] font-bold tracking-[-0.04em] text-night-ink">
                The <span className="type-engraved [--ink-c:var(--color-mint)]">market</span>
              </h1>
              <p className="mt-3 max-w-[48ch] text-lg text-night-ink-2">
                Every coin and the trade its fees are running. Sort by what you care about.
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.k} className="min-w-0">
                  <dt className="text-xs text-night-ink-2">{s.k}</dt>
                  <dd className="num mt-1 text-2xl font-semibold text-night-ink sm:text-3xl">{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="mt-12">
            <MoversStrip tone="night" />
          </div>
        </div>
      </section>
      <div className="mt-6">
        <TickerTape />
      </div>

      <Container width="wide">
        <div className="mt-14 grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-display text-2xl font-semibold">Coins</h2>
              <AutoRefresh everyMs={30_000} />
            </div>
            <CoinsBoard items={coins} pnl={pnl} />
          </div>
          <aside className="hidden xl:block">
            <PositionsSidebar />
          </aside>
        </div>
      </Container>
    </MarketsProvider>
  );
}
