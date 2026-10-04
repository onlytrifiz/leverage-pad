"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft, ArrowUpRight, Check, Copy } from "lucide-react";
import { cn } from "cn";
import type { CoinDetail } from "@/lib/types";
import { fmtChange, fmtInt, fmtMark } from "@/lib/format";
import { explorerAddr } from "@/lib/clientConfig";
import { useMarkets } from "@/components/markets-provider";
import { Banknote } from "@/components/brand/Banknote";
import { Guilloche } from "@/components/brand/Guilloche";
import { AnimatedNumber, LivePulse } from "@/components/motion";
import AssetIcon from "@/components/AssetIcon";
import { CoinAvatar } from "@/components/brand/CoinAvatar";

/**
 * A coin's page opens on its banknote, at night, like the home page.
 *
 * Left, the note itself (the same component as the hero, struck from this
 * coin's settings). Right, what someone arriving here wants first: the price,
 * the market cap, how far it has come since launch, and the asset its fees are
 * trading, live. Buy and Sell jump to the trade panel; nothing on this band
 * signs a transaction.
 */
export default function TokenHero({ detail, poolHref }: { detail: CoinDetail; poolHref: string }) {
  const { coin, stats, demo } = detail;
  const { markets } = useMarkets();
  const live = markets.find((m) => m.symbol === coin.market);
  const [copied, setCopied] = useState(false);

  const sinceLaunch =
    stats.marketCapUsd != null && coin.openingMcapUsd > 0 ? (stats.marketCapUsd / coin.openingMcapUsd - 1) * 100 : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(coin.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the address is still selectable in the explorer link */
    }
  };

  return (
    <section className="intro-night behind-nav relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]">
      <div aria-hidden className="pointer-events-none absolute top-1/2 left-[30%] -z-10 -translate-x-1/2 -translate-y-1/2 text-mint/[0.1]">
        <Guilloche
          teeth={17 + coin.leverage}
          reach={0.8}
          rings={4}
          size={980}
          spin={160}
          direction={coin.side === "short" ? -1 : 1}
          className="w-[140vw] max-w-[980px]"
        />
      </div>

      <div className="mx-auto w-full max-w-[1320px] px-4 pt-6 pb-10 sm:px-5 sm:pb-14">
        <Link href="/market" className="inline-flex items-center gap-1.5 text-sm text-night-ink-2 transition-colors hover:text-night-ink">
          <ArrowLeft size={14} aria-hidden />
          Market
        </Link>

        <div className="mt-6 grid grid-cols-1 items-center gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-14">
          <motion.div
            initial={{ opacity: 0, y: 30, rotate: -4 }}
            animate={{ opacity: 1, y: 0, rotate: 0 }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="min-w-0"
          >
            <Banknote
              symbol={coin.symbol}
              name={coin.name}
              market={coin.market}
              side={coin.side}
              leverage={coin.leverage}
              managed={coin.managed}
              serial={coin.token}
            />
          </motion.div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CoinAvatar image={coin.image} symbol={coin.symbol} size={44} className="mr-1 border-night-line" />
              <h1 className="font-display text-3xl font-bold tracking-[-0.03em] text-night-ink sm:text-4xl">
                ${coin.symbol}
                <span className="text-night-ink-2"> / {coin.pairSymbol}</span>
              </h1>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                  demo ? "border-night-line text-night-ink-2" : "border-mint/30 text-mint"
                )}
              >
                {!demo && <LivePulse tone="brand" />}
                {demo ? "Demo data" : "Live"}
              </span>
            </div>
            <p className="mt-1 truncate text-night-ink-2">{coin.name}</p>

            <div className="mt-6 text-xs tracking-wide text-night-ink-2">Price</div>
            <div className="num mt-1 text-[clamp(36px,6vw,60px)] leading-none font-semibold tracking-[-0.02em] text-night-ink">
              <AnimatedNumber value={stats.priceUsd} format="price" countOnMount />
            </div>

            <dl className="mt-6 grid grid-cols-3 gap-4 border-y border-night-line py-4">
              <div className="min-w-0">
                <dt className="text-2xs text-night-ink-2">Market cap</dt>
                <dd className="num mt-1 truncate text-lg font-semibold text-night-ink">
                  <AnimatedNumber value={stats.marketCapUsd} format="usd" countOnMount />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-2xs text-night-ink-2">Since launch</dt>
                <dd
                  className={cn(
                    "num mt-1 truncate text-lg font-semibold",
                    sinceLaunch == null ? "text-night-ink" : sinceLaunch >= 0 ? "text-night-up" : "text-night-down"
                  )}
                >
                  {fmtChange(sinceLaunch, 1)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-2xs text-night-ink-2">Burned</dt>
                <dd className="num mt-1 truncate text-lg font-semibold text-mint">{fmtInt(stats.burnedTokens)}</dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-night-ink-2">
              <span>Its fees trade</span>
              <span className="inline-flex items-center gap-1.5 text-night-ink">
                <AssetIcon symbol={coin.market} size={16} />
                {coin.market} {coin.leverage}x {coin.side}
              </span>
              {live && (
                <>
                  <span className="num text-night-ink">{fmtMark(live.mark)}</span>
                  <span className={cn("num", (live.change24h ?? 0) >= 0 ? "text-night-up" : "text-night-down")}>
                    {fmtChange(live.change24h, 2)} today
                  </span>
                </>
              )}
            </div>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href="#trade"
                className="inline-flex h-11 items-center rounded-xl bg-mint px-6 text-md font-semibold text-night transition-transform hover:-translate-y-0.5"
              >
                Buy ${coin.symbol}
              </a>
              <a
                href="#trade"
                className="inline-flex h-11 items-center rounded-xl border border-night-line px-5 text-md font-semibold text-night-ink transition-colors hover:border-night-ink-2"
              >
                Sell
              </a>
              <button
                type="button"
                onClick={copy}
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-night-line px-4 text-sm text-night-ink-2 transition-colors hover:border-night-ink-2 hover:text-night-ink"
              >
                <span className="num">{coin.token.slice(0, 6)}…{coin.token.slice(-4)}</span>
                {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                <span className="sr-only">{copied ? "Copied" : "Copy contract address"}</span>
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
              {(
                [
                  ["Website", coin.socials?.website],
                  ["X", coin.socials?.x],
                  ["Telegram", coin.socials?.telegram],
                ] as const
              ).map(([label, href]) =>
                href ? (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noreferrer nofollow"
                    className="inline-flex items-center gap-1 font-medium text-night-ink hover:text-mint"
                  >
                    {label} <ArrowUpRight size={12} aria-hidden />
                  </a>
                ) : null
              )}
              <a href={poolHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-night-ink-2 hover:text-night-ink">
                Pool <ArrowUpRight size={12} aria-hidden />
              </a>
              <a href={explorerAddr(coin.subWallet)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-night-ink-2 hover:text-night-ink">
                Fee wallet <ArrowUpRight size={12} aria-hidden />
              </a>
              <a href={explorerAddr(coin.token)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-night-ink-2 hover:text-night-ink">
                Token <ArrowUpRight size={12} aria-hidden />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
