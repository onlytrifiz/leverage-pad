import Link from "next/link";
import { notFound } from "next/navigation";
import { coinDetail } from "@/lib/detail";
import { LOCKER } from "@/lib/config";
import { explorerAddr } from "@/lib/clientConfig";
import { fmtUsd, fmtPrice, fmtInt } from "@/lib/format";
import Chart from "@/components/Chart";
import LiveFeed from "@/components/LiveFeed";
import SwapPanel from "@/components/SwapPanel";
import BurnOdometer from "@/components/BurnOdometer";
import HedgeCard from "@/components/HedgeCard";
import TranchePanel from "@/components/TranchePanel";
import VerifySection from "@/components/VerifySection";
import AutoRefresh from "@/components/AutoRefresh";
import { HedgeBadge, DemoBadge, LiveBadge } from "@/components/Badge";
import { CopyChip, LinkChip } from "@/components/CopyChip";

export const dynamic = "force-dynamic";

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
    <div className="pt-6">
      <AutoRefresh />
      <Link href="/" className="lbl transition-colors hover:text-ink-2">
        ← all coins
      </Link>

      {/* ── header ─────────────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[28px] font-bold leading-none tracking-tight">
              ${coin.symbol}
              <span className="text-ink-3"> / {coin.pairSymbol}</span>
            </h1>
            <HedgeBadge side={coin.side} market={coin.market} leverage={coin.leverage} />
            {demo ? <DemoBadge /> : <LiveBadge />}
          </div>
          <div className="mt-1.5 text-[13px] text-ink-2">{coin.name}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CopyChip label="CA:" value={coin.token} />
            <LinkChip label="pool" href={explorerAddr(coin.pool)} />
            <LinkChip label="sub-wallet" href={explorerAddr(coin.subWallet)} />
          </div>
        </div>
        <div className="text-right">
          <div className="lbl">market cap</div>
          <div className="num green-glow mt-1 text-[32px] font-bold leading-none text-accent-bright">
            {fmtUsd(stats.marketCapUsd)}
          </div>
          <div className="lbl mt-2 flex items-center justify-end gap-1.5 normal-case tracking-normal">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-bright" />
            price {fmtPrice(stats.priceUsd)}
          </div>
        </div>
      </div>

      {/* ── body: colonna principale + colonna trade/verify ────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          <Chart address={coin.token} symbol={coin.symbol} />

          <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-line/50 sm:grid-cols-4">
            {[
              { label: "market cap", value: fmtUsd(stats.marketCapUsd) },
              { label: "price", value: fmtPrice(stats.priceUsd) },
              { label: "underlying", value: `${coin.side} ${coin.market}` },
              { label: "paired with", value: coin.pairSymbol },
            ].map((s) => (
              <div key={s.label} className="bg-panel px-4 py-3">
                <div className="lbl mb-1">{s.label}</div>
                <div className="num text-[15px] font-semibold uppercase">{s.value}</div>
              </div>
            ))}
          </div>

          <HedgeCard detail={detail} />

          <TranchePanel detail={detail} />

          {/* motore: fee → burn (firma) → perp */}
          <div className="panel grid grid-cols-1 gap-px overflow-hidden bg-line/50 sm:grid-cols-3">
            <div className="bg-panel px-4 py-4">
              <div className="lbl mb-1.5">fees collected</div>
              <div className="num text-[20px] font-semibold">{fmtUsd(stats.feesCollectedUsd)}</div>
              <div className="lbl mt-2 normal-case tracking-normal">
                split: 100% perp treasury — full degen
              </div>
            </div>
            <div className="bg-panel px-4 py-4">
              <BurnOdometer burned={stats.burnedTokens} burnedPct={stats.burnedPct} />
            </div>
            <div className="bg-panel px-4 py-4">
              <div className="lbl mb-1.5">perp funded</div>
              <div className="num text-[20px] font-semibold">{fmtUsd(stats.perpFundedUsd)}</div>
              <div className="lbl mt-2 normal-case tracking-normal">
                usdg sent to lighter as collateral
              </div>
            </div>
          </div>

          {/* bucket in attesa */}
          <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-line/50 sm:grid-cols-4">
            {[
              { label: "perp reserve", value: fmtUsd(stats.perpReserveUsd), hint: "opens at $20" },
              { label: "buyback reserve", value: fmtUsd(stats.buybackReserveUsd), hint: "burns at $25" },
              { label: "creator owed", value: fmtUsd(stats.creatorOwedUsd), hint: "pays at $1" },
              { label: "treasury owed", value: fmtUsd(stats.treasuryOwedUsd), hint: "pays at $1" },
            ].map((s) => (
              <div key={s.label} className="bg-panel px-4 py-3">
                <div className="lbl mb-1">{s.label}</div>
                <div className="num text-[14px] font-medium">{s.value}</div>
                <div className="lbl mt-1 normal-case tracking-normal">{s.hint}</div>
              </div>
            ))}
          </div>

          <LiveFeed address={coin.token} demo={demo} />
        </div>

        <div className="min-w-0 space-y-4">
          <SwapPanel detail={detail} />

          <div className="panel">
            <div className="panel-head">
              <span className="lbl">sub-wallet balance</span>
            </div>
            <div className="grid grid-cols-2 gap-px bg-line/50">
              <div className="bg-panel px-4 py-3">
                <div className="lbl mb-1">{coin.pairSymbol}</div>
                <div className="num text-[14px] font-medium">{fmtUsd(detail.subWallet.quoteBalanceUsd)}</div>
              </div>
              <div className="bg-panel px-4 py-3">
                <div className="lbl mb-1">{coin.symbol}</div>
                <div className="num text-[14px] font-medium">{fmtInt(detail.subWallet.coinBalance)}</div>
              </div>
            </div>
            <p className="px-4 py-3 text-[11px] leading-relaxed text-ink-3">
              Holds fees between keeper ticks. Coin side burns every tick; the quote side
              splits into the four buckets above.
            </p>
          </div>

          <VerifySection coin={coin} locker={LOCKER} />
        </div>
      </div>
    </div>
  );
}
