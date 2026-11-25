import { notFound } from "next/navigation";
import { coinDetail } from "@/lib/detail";
import { dexscreenerPool } from "@/lib/doppler";
import { Container } from "@/components/ui/container";
import { isIndexed, dexEmbed, dexPage } from "@/components/Chart";
import { MarketsProvider } from "@/components/markets-provider";
import LiveFeed from "@/components/LiveFeed";
import SwapPanel from "@/components/SwapPanel";
import TranchePanel from "@/components/TranchePanel";
import VerifySection from "@/components/VerifySection";
import TokenHero from "@/components/token/TokenHero";
import AssetPanel from "@/components/token/AssetPanel";
import CoinChart from "@/components/token/CoinChart";
import EngineCockpit from "@/components/token/EngineCockpit";
import EngineFlow from "@/components/token/EngineFlow";
import ManageEngine from "@/components/token/ManageEngine";
import EngineHistory from "@/components/token/EngineHistory";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const detail = await coinDetail(address);
  if (!detail) return { title: "Token not found" };
  return {
    title: `$${detail.coin.symbol} · ${detail.coin.leverage}× ${detail.coin.side} ${detail.coin.market}`,
    description: `${detail.coin.name}: trading fees fund a ${detail.coin.leverage}× ${detail.coin.side} perp on ${detail.coin.market}, every take-profit buys back and burns.`,
  };
}

/**
 * A coin's page, in the order someone reads it: the note and the price, the
 * chart with the engine's buybacks on it, the engine itself live, where the
 * fees went, then the detail (tranches, feed). Trading stays in reach in a
 * sticky column on desktop, and right after the chart on a phone.
 */
export default async function TokenPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const detail = await coinDetail(address);
  if (!detail) notFound();
  const { coin } = detail;
  const indexed = await isIndexed(coin.poolId);

  return (
    <MarketsProvider>
      <TokenHero detail={detail} poolHref={dexscreenerPool(coin.poolId)} />

      {/*
        One trade column, rendered once. On a phone the main column dissolves
        (`contents`) so the trade panel can sit right after the chart; on
        desktop it is a sticky column beside the long read.
      */}
      <Container width="landing" className="mt-8 grid [--chart-h:520px] grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6 max-lg:contents">
          <div className="min-w-0 max-lg:order-1">
            <CoinChart
              address={coin.token}
              symbol={coin.symbol}
              supply={detail.stats.totalSupply}
              ageS={Math.max(0, detail.stats.updatedAt - Math.floor(new Date(coin.createdAt).getTime() / 1000))}
              dexSrc={indexed ? dexEmbed(coin.poolId) : null}
              dexPage={dexPage(coin.poolId)}
            />
          </div>
          <div className="min-w-0 max-lg:order-3">
            <EngineCockpit detail={detail} />
          </div>
          <div className="min-w-0 empty:hidden max-lg:order-3">
            <ManageEngine coin={coin} delayS={detail.managedDelayS} />
          </div>
          <div className="min-w-0 empty:hidden max-lg:order-3">
            <EngineHistory coin={coin} now={detail.stats.updatedAt} />
          </div>
          <div className="min-w-0 max-lg:order-3">
            <EngineFlow detail={detail} />
          </div>
          <div className="min-w-0 max-lg:order-3">
            <TranchePanel detail={detail} />
          </div>
          <div className="min-w-0 max-lg:order-3">
            <LiveFeed address={coin.token} demo={detail.demo} />
          </div>
          <div className="min-w-0 max-lg:order-3">
            <VerifySection coin={coin} />
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 max-lg:order-2 lg:sticky lg:top-[calc(var(--nav-h)+16px)] lg:h-[var(--chart-h)] lg:self-start">
          <TradeColumn detail={detail} />
        </aside>
      </Container>
    </MarketsProvider>
  );
}

function TradeColumn({ detail }: { detail: NonNullable<Awaited<ReturnType<typeof coinDetail>>> }) {
  return (
    <>
      <div id="trade" className="scroll-mt-[calc(var(--nav-h)+16px)]">
        <SwapPanel detail={detail} />
      </div>
      <AssetPanel detail={detail} />
    </>
  );
}
