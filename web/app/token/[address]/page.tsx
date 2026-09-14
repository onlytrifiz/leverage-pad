import Link from "next/link";
import { notFound } from "next/navigation";
import { coinDetail } from "@/lib/detail";
import {
  OPEN_GATE_LABEL,
  BUYBACK_FLOOR_LABEL,
  CREATOR_MIN_PAYOUT_LABEL,
} from "@/lib/thresholds";
import { explorerAddr } from "@/lib/clientConfig";
import { dexscreenerPool } from "@/lib/doppler";
import { Container } from "@/components/ui/container";
import { Panel, PanelHeader, PanelTitle, PanelBody } from "@/components/ui/panel";
import { StatGrid, Stat } from "@/components/ui/stat";
import Chart from "@/components/Chart";
import LiveFeed from "@/components/LiveFeed";
import SwapPanel from "@/components/SwapPanel";
import BurnOdometer from "@/components/BurnOdometer";
import HedgeCard from "@/components/HedgeCard";
import TranchePanel from "@/components/TranchePanel";
import VerifySection from "@/components/VerifySection";
import AutoRefresh from "@/components/AutoRefresh";
import { AnimatedNumber, LivePulse } from "@/components/motion";
import { HedgeBadge, DemoBadge, LiveBadge } from "@/components/Badge";
import { CopyChip, LinkChip } from "@/components/CopyChip";
import { CoinSeal } from "@/components/brand/CoinSeal";

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

export default async function TokenPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const detail = await coinDetail(address);
  if (!detail) notFound();
  const { coin, stats, demo } = detail;

  return (
    <Container className="pt-6">
      <Link href="/" className="text-sm text-ink-3 transition-colors hover:text-ink">
        ← All coins
      </Link>

      {/*
        The coin's page opens as the instrument it is: its own seal on the left,
        struck from the leverage, side and risk profile fixed at launch.
      */}
      <section className="frame-engraved hatch mt-4 rounded-[16px] px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-5">
          <div className="flex min-w-0 items-center gap-5">
            <CoinSeal
              leverage={coin.leverage}
              side={coin.side}
              riskProfile={coin.riskProfile}
              size={104}
              rings={4}
              className="hidden shrink-0 text-brand sm:block"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1 className="text-4xl font-bold leading-none">
                  ${coin.symbol}
                  <span className="text-ink-3"> / {coin.pairSymbol}</span>
                </h1>
                <HedgeBadge side={coin.side} market={coin.market} leverage={coin.leverage} />
                {demo ? <DemoBadge /> : <LiveBadge />}
              </div>
              <p className="mt-2 text-md text-ink-2">{coin.name}</p>
              <div className="mt-3.5 flex min-w-0 flex-wrap items-center gap-2">
                <CopyChip label="CA" value={coin.token} />
                <LinkChip label="Pool" href={dexscreenerPool(coin.poolId)} />
                <LinkChip label="Fees to" href={explorerAddr(coin.subWallet)} />
              </div>
            </div>
          </div>
          <div className="min-w-0 text-left sm:text-right">
            <div className="text-xs text-ink-3">Market cap</div>
            <div className="num mt-1 text-4xl font-semibold leading-none text-ink">
              <AnimatedNumber value={stats.marketCapUsd} format="usd" countOnMount />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3 sm:justify-end">
              <LivePulse />
              <span>
                Price <AnimatedNumber value={stats.priceUsd} format="price" className="num" />
              </span>
              <span aria-hidden>·</span>
              <AutoRefresh />
            </div>
          </div>
        </div>
      </section>

      {/* ── body: main column + trade/addresses column ──────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Chart pool={coin.poolId} symbol={coin.symbol} />

          <StatGrid>
            <Stat label="Market cap" amount={stats.marketCapUsd} format="usd" size="sm" />
            <Stat label="Price" amount={stats.priceUsd} format="price" size="sm" />
            <Stat
              label="Underlying"
              value={<span className="capitalize">{coin.side} {coin.market}</span>}
              mono={false}
              size="sm"
            />
            <Stat label="Paired with" value={coin.pairSymbol} mono={false} size="sm" />
          </StatGrid>

          <HedgeCard detail={detail} />

          <TranchePanel detail={detail} />

          {/* the engine: fees → burn → perp */}
          <StatGrid cols={3}>
            <Stat
              label="Fees collected"
              amount={stats.feesCollectedUsd}
              format="usd"
              size="lg"
              hint="Always in USDG. 100% perp treasury, full degen"
            />
            <Stat label="Burned">
              <BurnOdometer burned={stats.burnedTokens} burnedPct={stats.burnedPct} />
            </Stat>
            <Stat
              label="Perp funded"
              amount={stats.perpFundedUsd}
              format="usd"
              size="lg"
              hint="USDG sent to Lighter as collateral"
            />
          </StatGrid>

          {/* buckets waiting on their gate */}
          <StatGrid>
            <Stat
              label="Perp reserve"
              amount={stats.perpReserveUsd}
              format="usd"
              size="sm"
              hint={`Opens at ${OPEN_GATE_LABEL}`}
            />
            <Stat
              label="Buyback reserve"
              amount={stats.buybackReserveUsd}
              format="usd"
              size="sm"
              hint={`Burns at ${BUYBACK_FLOOR_LABEL}`}
            />
            <Stat
              label="Creator owed"
              amount={stats.creatorOwedUsd}
              format="usd"
              size="sm"
              hint={`Pays at ${CREATOR_MIN_PAYOUT_LABEL}`}
            />
            <Stat
              label="Treasury owed"
              amount={stats.treasuryOwedUsd}
              format="usd"
              size="sm"
              hint={`Pays at ${CREATOR_MIN_PAYOUT_LABEL}`}
            />
          </StatGrid>

          <LiveFeed address={coin.token} demo={demo} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SwapPanel detail={detail} />

          <Panel>
            <PanelHeader>
              <PanelTitle>Fee destination balance</PanelTitle>
            </PanelHeader>
            <div className="grid grid-cols-2 gap-px bg-border">
              <Stat
                label={coin.pairSymbol}
                amount={detail.subWallet.quoteBalanceUsd}
                format="usd"
                size="sm"
              />
              <Stat
                label={coin.symbol}
                amount={detail.subWallet.coinBalance}
                format="int"
                size="sm"
              />
            </div>
            <PanelBody className="pt-3.5">
              <p className="text-xs leading-relaxed text-ink-3">
                Every fee arrives here in USDG, converted by the pool&apos;s hook in the same
                swap. From here it funds the perp; buybacks are burned.
              </p>
            </PanelBody>
          </Panel>

          <VerifySection coin={coin} />
        </div>
      </div>
    </Container>
  );
}
