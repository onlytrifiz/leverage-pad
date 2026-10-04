import { notFound } from "next/navigation";
import { coinDetail } from "@/lib/detail";
import { dexscreenerPool } from "@/lib/doppler";
import { Container } from "@/components/ui/container";
import { Panel, PanelHeader, PanelTitle, PanelBody } from "@/components/ui/panel";
import { Stat } from "@/components/ui/stat";
import { isIndexed, dexEmbed, dexPage } from "@/components/Chart";
import { MarketsProvider } from "@/components/markets-provider";
import LiveFeed from "@/components/LiveFeed";
import SwapPanel from "@/components/SwapPanel";
import TranchePanel from "@/components/TranchePanel";
import VerifySection from "@/components/VerifySection";
import AutoRefresh from "@/components/AutoRefresh";
import TokenHero from "@/components/token/TokenHero";
import CoinChart from "@/components/token/CoinChart";
import EngineCockpit from "@/components/token/EngineCockpit";
import EngineFlow from "@/components/token/EngineFlow";
import ManageEngine from "@/components/token/ManageEngine";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const detail = await coinDetail(address);
  if (!detail) return { title: "Coin not found" };
  return {
    title: `$${detail.coin.symbol} · ${detail.coin.leverage}× ${detail.coin.side} ${detail.coin.market}`,
    description: `${detail.coin.name}: trading fees fund a ${detail.coin.leverage}× ${detail.coin.side} perp on ${detail.coin.market}, profits buy back and burn.`,
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
  const launchPrice = coin.openingMcapUsd > 0 ? coin.openingMcapUsd / (coin.initialSupply ?? 1e9) : null;

  return (
    <MarketsProvider>
      <TokenHero detail={detail} poolHref={dexscreenerPool(coin.poolId)} />

      {/*
        One trade column, rendered once. On a phone the main column dissolves
        (`contents`) so the trade panel can sit right after the chart; on
        desktop it is a sticky column beside the long read.
      */}
      <Container width="landing" className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6 max-lg:contents">
          <div className="min-w-0 max-lg:order-1">
            <CoinChart
              address={coin.token}
              symbol={coin.symbol}
              launchPrice={launchPrice}
              launchedAt={Math.floor(new Date(coin.createdAt).getTime() / 1000) || null}
              dexSrc={indexed ? dexEmbed(coin.poolId) : null}
              dexPage={dexPage(coin.poolId)}
            />
          </div>
          <div className="min-w-0 max-lg:order-3">
            <EngineCockpit detail={detail} />
          </div>
          <div className="min-w-0 empty:hidden max-lg:order-3">
            <ManageEngine coin={coin} />
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

        <aside className="flex min-w-0 flex-col gap-4 max-lg:order-2 lg:sticky lg:top-[calc(var(--nav-h)+16px)] lg:self-start">
          <TradeColumn detail={detail} />
        </aside>
      </Container>
    </MarketsProvider>
  );
}

function TradeColumn({ detail }: { detail: NonNullable<Awaited<ReturnType<typeof coinDetail>>> }) {
  const { coin } = detail;
  return (
    <>
      <div className="flex items-center justify-end">
        <AutoRefresh />
      </div>
      <div id="trade" className="scroll-mt-[calc(var(--nav-h)+16px)]">
        <SwapPanel detail={detail} />
      </div>
      <Panel>
        <PanelHeader>
          <PanelTitle>Fee wallet</PanelTitle>
        </PanelHeader>
        <div className="grid grid-cols-2 gap-px bg-border">
          <Stat label={coin.pairSymbol} amount={detail.subWallet.quoteBalanceUsd} format="usd" size="sm" />
          <Stat label={coin.symbol} amount={detail.subWallet.coinBalance} format="int" size="sm" />
        </div>
        <PanelBody className="pt-3.5">
          <p className="text-xs leading-relaxed text-ink-3">
            Every fee lands here in USDG, converted by the pool&apos;s hook in the same swap. From here it funds the
            position; coins that arrive are burned.
          </p>
        </PanelBody>
      </Panel>
    </>
  );
}
