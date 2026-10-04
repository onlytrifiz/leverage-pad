"use client";

import { useRef } from "react";
import Link from "next/link";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { ArrowUpRight, Play } from "lucide-react";
import { cn } from "cn";
import type { CoinListItem } from "@/lib/types";
import { fmtChange, fmtMark, fmtUsd } from "@/lib/format";
import { useMarkets } from "@/components/markets-provider";
import { useIntro } from "@/components/intro/intro-context";
import { Banknote } from "@/components/brand/Banknote";
import { Guilloche } from "@/components/brand/Guilloche";
import { AnimatedNumber } from "@/components/motion";
import AssetIcon from "@/components/AssetIcon";

/**
 * The hero, at night: the same lamp-lit forest as the intro, so the story
 * hands over to the site without a change of light.
 *
 * Three layers, back to front:
 *   moire   two large rosettes turning against each other. Their interference
 *           is the shimmer a real banknote shows when it moves; both turn on
 *           the compositor (see Guilloche), so it costs no repaint.
 *   lamp    a soft pool of mint that follows the pointer, as if the visitor
 *           were holding the note under a light.
 *   note    the featured coin as a banknote, tilting with the pointer and
 *           lifting away as the page scrolls.
 *
 * Below them, one row of live protocol figures. No card, no grid of boxes: the
 * numbers sit on the night like the denomination on a note.
 */
export default function HeroStage({
  featured,
  coins,
  liveEngines,
  totalFees,
  totalBurned,
}: {
  featured: CoinListItem | null;
  coins: number;
  liveEngines: number;
  totalFees: number;
  totalBurned: number;
}) {
  const reduced = useReducedMotion();
  const { open } = useIntro();
  const { markets } = useMarkets();
  const ref = useRef<HTMLElement>(null);

  const lx = useMotionValue(70);
  const ly = useMotionValue(30);
  const slx = useSpring(lx, { stiffness: 60, damping: 20 });
  const sly = useSpring(ly, { stiffness: 60, damping: 20 });
  const lamp = useMotionTemplate`radial-gradient(640px circle at ${slx}% ${sly}%, rgba(140,232,176,0.16), transparent 62%)`;

  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const noteY = useTransform(scrollYProgress, [0, 1], [0, -90]);
  const noteRotate = useTransform(scrollYProgress, [0, 1], [-2, -9]);

  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    if (reduced || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    lx.set(((e.clientX - r.left) / r.width) * 100);
    ly.set(((e.clientY - r.top) / r.height) * 100);
  };

  const coin = featured?.coin;
  const live = coin ? markets.find((m) => m.symbol === coin.market) : undefined;

  return (
    <section
      ref={ref}
      onPointerMove={onMove}
      className="intro-night relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]"
    >
      {/* moire: two rosettes turning against each other */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-1/2 left-[62%] -translate-x-1/2 -translate-y-1/2 text-mint/[0.14]">
          <Guilloche teeth={41} reach={0.85} rings={4} size={1100} spin={140} className="w-[150vw] max-w-[1100px]" />
        </div>
        <div className="absolute top-[54%] left-[66%] -translate-x-1/2 -translate-y-1/2 text-mint/[0.11]">
          <Guilloche teeth={37} reach={0.7} rings={4} size={1040} spin={170} direction={-1} className="w-[142vw] max-w-[1040px]" />
        </div>
      </div>
      <motion.div aria-hidden className="pointer-events-none absolute inset-0 -z-10" style={{ background: lamp }} />

      <div className="mx-auto grid w-full max-w-[1320px] grid-cols-1 items-center gap-12 px-4 pt-12 pb-10 sm:px-5 sm:pt-16 lg:min-h-[calc(100dvh-var(--header-h)-120px)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-10 lg:pt-10">
        <div className="min-w-0">
          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="font-display text-[clamp(52px,8.4vw,116px)] leading-[0.92] font-bold tracking-[-0.045em] text-night-ink"
          >
            Every trade
            <br />
            funds
            <br />
            <span className="type-engraved whitespace-nowrap pr-[0.04em] [--ink-c:var(--color-mint)]">a trade.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="mt-7 max-w-[40ch] text-lg leading-relaxed text-night-ink-2 sm:text-xl sm:leading-relaxed"
          >
            Swap fees open a leveraged perp on the asset you pick. Wins buy the coin back and burn it.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="mt-9 flex flex-wrap items-center gap-3"
          >
            <Link
              href="/launch"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-mint px-6 text-md font-semibold text-night shadow-[0_10px_30px_-10px_rgba(140,232,176,0.6)] transition-transform hover:-translate-y-0.5 active:translate-y-0"
            >
              Launch a coin
              <ArrowUpRight size={16} aria-hidden />
            </Link>
            <button
              type="button"
              onClick={open}
              className="inline-flex h-12 items-center gap-2 rounded-xl border border-night-line px-5 text-md font-semibold text-night-ink transition-colors hover:border-night-ink-2"
            >
              <Play size={14} aria-hidden />
              How it works
            </button>
          </motion.div>
        </div>

        {/* the note */}
        <motion.div
          initial={{ opacity: 0, y: 40, rotate: -6 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ duration: 1.1, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="relative min-w-0"
        >
          <motion.div style={reduced ? undefined : { y: noteY, rotate: noteRotate }}>
            <Banknote
              symbol={coin?.symbol ?? "YOURCOIN"}
              name={coin?.name ?? "Your coin, backed by the asset you pick"}
              market={coin?.market ?? "NVDA"}
              side={coin?.side ?? "long"}
              leverage={coin?.leverage ?? 10}
              managed={coin?.managed}
              serial={coin?.token ?? "0x0000000000000000000000000000000000000000"}
            />
          </motion.div>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-night-ink-2">
            {coin && (
              <span className="flex items-center gap-2">
                <AssetIcon symbol={coin.market} size={16} />
                <span className="text-night-ink">{coin.market}</span>
                <span className="num text-night-ink">{fmtMark(live?.mark)}</span>
                <span className={cn("num", (live?.change24h ?? 0) >= 0 ? "text-night-up" : "text-night-down")}>
                  {fmtChange(live?.change24h, 1)}
                </span>
              </span>
            )}
            {featured?.marketCapUsd != null && (
              <span>
                Market cap <span className="num text-night-ink">{fmtUsd(featured.marketCapUsd)}</span>
              </span>
            )}
            {coin ? (
              <Link
                href={`/token/${coin.token}`}
                className="ml-auto inline-flex items-center gap-1 font-semibold text-mint hover:underline"
              >
                {featured?.demo ? "Demo coin" : `Open $${coin.symbol}`}
                <ArrowUpRight size={14} aria-hidden />
              </Link>
            ) : null}
          </div>
        </motion.div>
      </div>

      {/* the protocol, live, set on the night like a denomination */}
      <div className="mx-auto w-full max-w-[1320px] px-4 pb-10 sm:px-5 sm:pb-14">
        <dl className="grid grid-cols-2 gap-y-6 border-t border-night-line pt-7 md:grid-cols-4">
          {[
            { k: "Coins launched", v: <AnimatedNumber value={coins} format="plain" countOnMount /> },
            { k: "Engines live", v: <AnimatedNumber value={liveEngines} format="plain" countOnMount /> },
            { k: "Fees put to work", v: <AnimatedNumber value={totalFees} format="usd" countOnMount /> },
            { k: "Tokens burned", v: <AnimatedNumber value={totalBurned} format="int" countOnMount /> },
          ].map((s, i) => (
            <div key={s.k} className={cn("min-w-0 pr-4", i % 2 === 1 && "md:border-l md:border-night-line md:pl-6", i >= 2 && "md:border-l md:border-night-line md:pl-6")}>
              <dt className="text-xs tracking-wide text-night-ink-2">{s.k}</dt>
              <dd className="num mt-1.5 truncate text-3xl font-semibold text-night-ink sm:text-4xl">{s.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
