import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { listCoins } from "@/lib/detail";
import { Container } from "@/components/ui/container";
import { MarketsProvider } from "@/components/markets-provider";
import TickerTape from "@/components/TickerTape";
import HeroStage from "@/components/home/HeroStage";
import { RevealBlock } from "@/components/motion";
import SmoothScroll from "@/components/home/SmoothScroll";
import PayoffSimulator from "@/components/home/PayoffSimulator";
import FeeDestination from "@/components/home/FeeDestination";
import EngineLoop from "@/components/home/EngineLoop";
import Faq from "@/components/home/Faq";
import FinalCta from "@/components/home/FinalCta";
import MarketPreview from "@/components/market/MarketPreview";
import type { CoinListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

/** the coin on the hero certificate: a live engine first, then the biggest market cap */
function pickFeatured(coins: CoinListItem[]): CoinListItem | null {
  const byCap = (a: CoinListItem, b: CoinListItem) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0);
  return [...coins].sort((a, b) => Number(b.perpOpen) - Number(a.perpOpen) || byCap(a, b))[0] ?? null;
}

/**
 * The home page reads in two halves.
 *
 * The top half explains the product to someone who has never seen it: the
 * claim, an instrument to push, where a fee goes, and the loop. Then a preview
 * of the live coins; the full board is its own page, /market.
 */
export default async function Home() {
  const coins = await listCoins();
  const totalFees = coins.reduce((a, c) => a + c.feesCollectedUsd, 0);
  const totalBurned = coins.reduce((a, c) => a + c.burnedTokens, 0);
  const liveEngines = coins.filter((c) => c.perpOpen).length;

  return (
    <SmoothScroll>
      <MarketsProvider>
        <TickerTape />

        <HeroStage
          featured={pickFeatured(coins)}
          coins={coins.length}
          liveEngines={liveEngines}
          totalFees={totalFees}
          totalBurned={totalBurned}
        />

        {/* the asymmetry, as an instrument */}
        <Container width="landing" className="pt-20 sm:pt-28">
          <RevealBlock className="max-w-[640px]">
            <h2 className="text-4xl leading-[1.08] font-bold tracking-[-0.03em] sm:text-5xl">
              Upside from the market. <span className="text-brand">Downside capped at the fees.</span>
            </h2>
            <p className="mt-4 max-w-[52ch] text-lg leading-relaxed text-ink-2">
              Drag across the chart and follow the money. Losses stop at the fees the position was given; wins come
              back as buybacks.
            </p>
          </RevealBlock>
          <RevealBlock delay={0.1} className="mt-10">
            <PayoffSimulator />
          </RevealBlock>
        </Container>

        {/* where a fee goes */}
        <Container width="landing" className="pt-24 sm:pt-32">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20">
            <RevealBlock className="min-w-0">
              <h2 className="text-4xl leading-[1.08] font-bold tracking-[-0.03em] sm:text-5xl">
                Where a $100 fee goes.
              </h2>
              <p className="mt-4 max-w-[40ch] text-lg leading-relaxed text-ink-2">
                Most launchpads keep the fee. Here, most of it becomes working capital for the coin that paid it.
              </p>
            </RevealBlock>
            <div className="min-w-0 lg:pt-3">
              <FeeDestination />
            </div>
          </div>
        </Container>

        {/* the loop */}
        <Container width="landing" className="pt-24 sm:pt-32">
          <RevealBlock className="max-w-[640px]">
            <h2 className="text-4xl leading-[1.08] font-bold tracking-[-0.03em] sm:text-5xl">
              One loop, every 15 seconds.
            </h2>
          </RevealBlock>
          <div className="mt-12">
            <EngineLoop />
          </div>
        </Container>

        {/* the market, a preview: the full board lives on /market */}
        <div id="market" className="scroll-mt-[calc(var(--nav-h)+12px)] pt-24 sm:pt-32">
          <Container width="landing">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-4xl leading-[1.08] font-bold tracking-[-0.03em] sm:text-5xl">Live now</h2>
              <Link
                href="/market"
                className="inline-flex items-center gap-1.5 text-md font-semibold text-brand underline-offset-4 hover:underline"
              >
                Open the market
                <ArrowUpRight size={16} aria-hidden />
              </Link>
            </div>
            <div className="mt-8">
              <MarketPreview items={coins} />
            </div>
          </Container>
        </div>

        {/* questions */}
        <Container width="page" className="pt-24 sm:pt-32">
          <div className="mx-auto max-w-[820px]">
            <RevealBlock>
              <h2 className="text-4xl leading-[1.08] font-bold tracking-[-0.03em] sm:text-5xl">Before you buy.</h2>
              <p className="mt-4 text-lg leading-relaxed text-ink-2">
                The short answers. The long ones are in the{" "}
                <Link href="/docs" className="font-medium text-brand underline underline-offset-4 hover:text-brand-strong">
                  docs
                </Link>
                .
              </p>
            </RevealBlock>
            <div className="mt-8">
              <Faq />
            </div>
          </div>
        </Container>

        <Container width="landing" className="pt-24 sm:pt-32">
          <FinalCta />
        </Container>
      </MarketsProvider>
    </SmoothScroll>
  );
}
