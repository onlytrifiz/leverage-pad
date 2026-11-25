"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import { gsap, useGSAP, EASE_OUT } from "@/lib/gsap";
import { EngravedArt } from "@/components/brand/EngravedArt";
import { Guilloche } from "@/components/brand/Guilloche";
import { EngineCoin } from "@/components/brand/EngineCoin";
import { LogoMark } from "@/components/brand/LogoMark";
import AssetIcon from "@/components/AssetIcon";
import { PROFIT_SPLIT_PCT } from "@/lib/doppler";

/**
 * The six chapters of the intro.
 *
 * The story: tokens need volume and the volume left; markets still move; so
 * each token holds a perp, and the perp buys the token.
 *
 * One worked example runs through the last chapters so the numbers add up:
 * $1,540 of fees already in the engine, at 20x a $30,800 position, an 8% move is
 * $2,464 of profit and 70% of it, $1,725, buys the token back. 20x is Lighter's
 * own cap on NVDA. A position is loaded by fees once; after that it works whether
 * or not anyone is trading, which is the claim the Pump chapter draws.
 * Every plate that shows those figures says it is an example.
 *
 * Each chapter is one GSAP timeline built in `useChapter`. The shell pauses it
 * while a finger is held down and jumps it to the end under reduced motion.
 */

export type SlideProps = { paused: boolean; reduced: boolean; onClose: () => void };

const EX = {
  asset: "NVDA",
  /** what the engine's share of past fees has put in the token's wallet */
  collateral: 1_540,
  leverage: 20,
  get notional() {
    return this.collateral * this.leverage;
  },
  pump: 8,
  get profit() {
    return (this.notional * this.pump) / 100;
  },
  get buyback() {
    return (this.profit * PROFIT_SPLIT_PCT.buyback) / 100;
  },
  dump: 12,
};

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/* ------------------------------------------------------------------ helpers */

function useChapter(
  { paused, reduced }: SlideProps,
  build?: (tl: gsap.core.Timeline, q: (sel: string) => Element[]) => void
) {
  const scope = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(scope);
      const t = gsap.timeline({ defaults: { ease: EASE_OUT } });
      t.from(q(".js-word"), { yPercent: 115, duration: 0.8, stagger: 0.045 });
      const body = q(".js-body");
      if (body.length) t.from(body, { y: 14, autoAlpha: 0, duration: 0.6 }, "-=0.5");
      build?.(t, q);
      if (reduced) t.progress(1).pause();
      tl.current = t;
    },
    { scope }
  );

  useEffect(() => {
    if (!reduced) tl.current?.paused(paused);
  }, [paused, reduced]);

  return scope;
}

/** a number that counts inside the timeline, written straight to the DOM */
function count(
  t: gsap.core.Timeline,
  el: Element | undefined,
  from: number,
  to: number,
  fmt: (n: number) => string,
  at: gsap.Position,
  duration = 1.2
) {
  if (!el) return;
  const o = { v: from };
  t.to(
    o,
    { v: to, duration, ease: "power2.out", onUpdate: () => void (el.textContent = fmt(o.v)) },
    at
  );
}

/** headline words, each in its own clip so it can rise into place */
function Words({ text, className }: { text: string; className?: string }) {
  const words = text.split(" ");
  return (
    <span className={className}>
      {words.map((w, i) => (
        <span key={i}>
          <span className="-mb-[0.14em] inline-block overflow-hidden pb-[0.14em] align-bottom">
            <span className="js-word inline-block">{w}</span>
          </span>
          {i < words.length - 1 ? " " : null}
        </span>
      ))}
    </span>
  );
}

function Frame({
  scope,
  title,
  accent,
  after,
  body,
  keepBody = false,
  children,
}: {
  scope: React.RefObject<HTMLDivElement | null>;
  title: string;
  accent: string;
  /** words after the accent, back in the headline colour */
  after?: string;
  body: React.ReactNode;
  /** the body carries something to act on (the last chapter's buttons): never hide it */
  keepBody?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={scope}
      className="mx-auto grid h-full w-full max-w-[1400px] content-center gap-7 px-4 pt-2 pb-[max(48px,env(safe-area-inset-bottom))] sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-16 lg:py-8"
    >
      <div className="min-w-0">
        <h2 className="font-display text-[clamp(34px,9.4vw,46px)] leading-[1.02] font-bold tracking-[-0.03em] text-balance text-night-ink lg:text-[clamp(44px,5.4vw,74px)]">
          <Words text={title} /> <Words text={accent} className="text-mint" />
          {after && (
            <>
              {" "}
              <Words text={after} />
            </>
          )}
        </h2>
        {/* a short phone keeps the headline and the plate; the paragraph only repeats them */}
        <p
          className={cn(
            "js-body mt-3 max-w-[44ch] text-[15px] leading-relaxed text-night-ink-2 sm:mt-6 sm:text-lg",
            !keepBody && "max-lg:[@media(max-height:720px)]:hidden"
          )}
        >
          {body}
        </p>
      </div>
      <div className="relative flex min-h-0 min-w-0 items-center justify-center">{children}</div>
    </div>
  );
}

function Plate({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="js-plate w-full max-w-[560px]">
      <div className={cn("relative rounded-[18px] border border-night-line bg-night-2 p-4 sm:p-6", className)}>
        {children}
      </div>
      <p className="mt-2 text-right text-2xs tracking-wide text-night-ink-2/70">Example figures</p>
    </div>
  );
}

/* deterministic walks: the same chart on every visit */
function walk(n: number, drift: number, wobble: number, seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + drift + rnd() * wobble));
  return out;
}

/* ----------------------------------------------------------------- chapters */

function Intro(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-rosette"), { scale: 0.6, autoAlpha: 0, duration: 1.6, ease: "expo.out" }, 0).from(
      q(".js-word2"),
      { yPercent: 115, duration: 0.8, stagger: 0.06 },
      1.4
    );
  });
  return (
    <div ref={scope} className="relative flex h-full items-center justify-center overflow-hidden px-4">
      <div className="js-rosette pointer-events-none absolute inset-0 flex items-center justify-center text-mint/30">
        <Guilloche teeth={33} reach={0.8} rings={6} size={760} spin={90} className="w-[min(130vw,760px)]" />
      </div>
      <h2 className="relative text-center font-display text-[clamp(38px,5.9vw,88px)] leading-[1] font-bold tracking-[-0.035em] text-balance">
        <span className="block text-night-ink">
          <Words text="Tokens need volume to run." />
        </span>
        <span className="js-line2 mt-3 block text-mint">
          {/* own words: they rise after the first line has landed */}
          {"That's why we fuel them with perps.".split(" ").map((w, i, a) => (
            <span key={i}>
              <span className="-mb-[0.14em] inline-block overflow-hidden pb-[0.14em] align-bottom">
                <span className="js-word2 inline-block">{w}</span>
              </span>
              {i < a.length - 1 ? " " : null}
            </span>
          ))}
        </span>
      </h2>
    </div>
  );
}

/*
 * Four markets on top, drawing hard moves at once; one token underneath, flat
 * as a monitor with nobody attached. Then a wire drops from NVDA to the token and
 * the flat line starts to beat. The shapes are drawn, not quotes: only NVDA's is a
 * real session, its +31% on 23 November 2026.
 */
const WILD = [
  { symbol: "NVDA", label: "+31.0%", up: true, pts: [52, 54, 50, 47, 49, 40, 44, 30, 34, 20, 23, 12, 15, 7] },
  { symbol: "XAU", label: "−4.2%", up: false, pts: [12, 8, 16, 13, 24, 20, 33, 27, 41, 36, 48, 42, 52, 49] },
  { symbol: "BTC", label: "−9.8%", up: false, pts: [10, 18, 9, 22, 30, 16, 34, 44, 28, 47, 40, 54, 45, 51] },
  { symbol: "OPENAI", label: "+17.5%", up: true, pts: [48, 52, 40, 46, 30, 42, 27, 33, 18, 29, 14, 22, 10, 13] },
] as const;
/* clip reveals: a dash offset is measured in screen pixels on a non-scaling stroke */
const HIDDEN = { clipPath: "inset(-10% 100% -10% 0%)" };
const SHOWN = { clipPath: "inset(-10% 0% -10% 0%)", ease: "none" };
const HIDDEN_BEAT = { clipPath: "inset(-10% 34.5% -10% 0%)" };
/* where the flat line ends and the beat begins, 65.5% across */
const FLAT_W = 400;
/* barely a ripple for two thirds of the chart, then the beat the wire brings */
const FLAT_PATH = "M0,62 L34,62 L38,60.5 L42,62 L112,62 L116,63 L120,62 L196,62 L200,61 L204,62 L262,62";
const BEAT_PATH = "M262,62 L274,62 L282,52 L290,68 L302,16 L314,44 L326,32 L340,38 L356,22 L372,27 L400,10";

function Wild(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-art"), { autoAlpha: 0, x: -60, duration: 2.6, ease: "power2.out" }, 0.2)
      .from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.3)
      .fromTo(q(".js-wild-line"), HIDDEN, { ...SHOWN, duration: 2.4, stagger: 0.12 }, 0.8)
      .from(q(".js-wild-tag"), { y: 6, autoAlpha: 0, duration: 0.35, stagger: 0.12 }, 2.6)
      // the token, over the same seconds: nothing
      .fromTo(q(".js-flat"), HIDDEN, { ...SHOWN, duration: 3 }, 0.8)
      // the wire, and the first beat
      .fromTo(q(".js-wire"), { scaleY: 0 }, { scaleY: 1, duration: 0.5, ease: "power2.in" }, 4.4)
      .from(q(".js-plug"), { scale: 0, autoAlpha: 0, duration: 0.3, ease: "back.out(3)" }, 4.85)
      .to(q(".js-off"), { autoAlpha: 0, duration: 0.2 }, 4.9)
      .fromTo(q(".js-on"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, 5)
      .fromTo(q(".js-beat"), HIDDEN_BEAT, { ...SHOWN, duration: 1.5 }, 4.95);
  });

  return (
    <Frame
      scope={scope}
      title="Tokens go flat."
      accent="Markets keep moving."
      body="NVDA can jump double digits in a day. Gold, bitcoin and AI names swing on real volume. An idle token doesn't print a candle. With a perp inside, it can."
    >
      <div className="relative w-full max-w-[560px] min-[360px]:mt-20 lg:mt-16">
        {/* faded at both ends: the sea has no edge, only the plate does */}
        <div className="js-art pointer-events-none absolute inset-x-2 bottom-[calc(100%-18px)] z-0 [mask-image:linear-gradient(to_right,transparent,black_14%,black_86%,transparent)] text-mint/60 max-[359px]:hidden">
          <EngravedArt name="storm" />
        </div>
        <Plate>
          <div className="relative">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {WILD.map((m, i) => (
                <div
                  key={m.symbol}
                  className={cn(
                    "relative min-w-0 rounded-lg border border-night-line bg-night/60 px-2.5 pt-2 pb-1.5",
                    i > 1 && "max-sm:[@media(max-height:700px)]:hidden"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <AssetIcon symbol={m.symbol} size={16} />
                    <span className="min-w-0 truncate text-2xs font-semibold text-night-ink">{m.symbol}</span>
                  </div>
                  <svg viewBox="0 0 130 60" className="js-wild-line mt-1 h-9 w-full sm:h-12" preserveAspectRatio="none" aria-hidden>
                    <path
                      d={m.pts.map((y, k) => `${k === 0 ? "M" : "L"}${k * 10},${y}`).join("")}
                      fill="none"
                      stroke={m.up ? "#6fe3a1" : "#ff8a7a"}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <div className={cn("js-wild-tag num text-sm font-semibold", m.up ? "text-night-up" : "text-night-down")}>
                    {m.label}
                  </div>
                </div>
              ))}
            </div>

            {/* the wire runs from the NVDA tile down to the token: the tile's centre, at either grid */}
            <div className="relative h-7 sm:h-9">
              <span className="js-wire absolute inset-y-0 left-1/4 w-px origin-top border-l border-dashed border-mint/70 sm:left-[12%]" />
              <span className="absolute bottom-0 left-1/4 -translate-x-1/2 translate-y-1/2 sm:left-[12%]">
                <span className="js-plug block size-2.5 rounded-full bg-mint shadow-[0_0_0_4px_rgba(140,232,176,0.25)]" />
              </span>
            </div>

            <div className="rounded-lg border border-night-line bg-night/60 p-3 sm:p-4">
              <div className="relative flex items-baseline justify-between gap-3 text-sm">
                <span className="grid font-semibold text-night-ink">
                  <span className="js-off col-start-1 row-start-1">A regular token</span>
                  <span className="js-on col-start-1 row-start-1 text-mint">A token with NVDA inside</span>
                </span>
                <span className="text-right text-2xs text-night-ink-2">
                  24h volume <span className="num text-night-ink">$214</span>
                </span>
              </div>
              <div className="relative mt-2 h-[72px] sm:h-[104px]">
                <svg viewBox={`0 0 ${FLAT_W} 80`} className="js-flat absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
                  <path d={FLAT_PATH} fill="none" stroke="rgba(159,196,173,0.75)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                </svg>
                <svg viewBox={`0 0 ${FLAT_W} 80`} className="js-beat absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
                  <path d={BEAT_PATH} fill="none" stroke="#8ce8b0" strokeWidth={2.75} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </svg>
              </div>
            </div>
          </div>
        </Plate>
      </div>
    </Frame>
  );
}

const ASSETS = ["BTC", "ETH", "SOL", "SPY", "XAU", "QQQ", "ANT", "NVDA"];

function Bet(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    const tiles = q(".js-tile");
    const lit = { borderColor: "#8ce8b0", backgroundColor: "rgba(140,232,176,0.14)" };
    const dim = { borderColor: "#1d4430", backgroundColor: "rgba(6,26,16,0.6)" };
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.3).from(q(".js-art"), { autoAlpha: 0, scale: 0.85, rotate: -8, duration: 1.4, ease: "expo.out" }, 0.2);
    // a scanner pass over the menu, landing on the last tile: the example asset
    tiles.forEach((tile, i) => {
      const at = 1 + i * 0.13;
      t.to(tile, { ...lit, duration: 0.08 }, at);
      if (i < tiles.length - 1) t.to(tile, { ...dim, duration: 0.25 }, at + 0.13);
    });
    t.from(q(".js-readout"), { y: 12, autoAlpha: 0, duration: 0.5 }, 2.2);
    // the leverage slider runs all the way up
    t.fromTo(q(".js-levfill"), { scaleX: 0 }, { scaleX: 1, duration: 1.1, ease: "power2.inOut" }, 2.7)
      .fromTo(q(".js-levthumb"), { left: "0%" }, { left: "100%", duration: 1.1, ease: "power2.inOut" }, 2.7);
    count(t, q(".js-levval")[0], 1, EX.leverage, (n) => `${Math.round(n)}x`, 2.7, 1.1);
    count(t, q(".js-notional")[0], EX.collateral, EX.notional, usd, 3.6, 1.1);
  });

  return (
    <Frame
      scope={scope}
      title="We put a"
      accent="perp"
      after="inside the token."
      body="Trading fees load it, in USDG. The creator picks the market, long or short, the leverage and when each deposit takes profit. From there the position works whether anyone trades or not."
    >
      <div className="relative w-full max-w-[560px] min-[360px]:mt-16 lg:mt-0">
        <div className="js-art pointer-events-none absolute right-[22%] bottom-[calc(100%-24px)] z-0 w-[34%] max-[359px]:hidden sm:w-[34%]">
          <EngineCoin />
        </div>
      <Plate>
        <div className="grid grid-cols-4 gap-2">
          {ASSETS.map((a) => (
            <div
              key={a}
              className="js-tile flex min-w-0 flex-col items-center gap-1.5 rounded-lg border border-night-line bg-night/60 px-1 py-2.5 sm:py-3"
            >
              <AssetIcon symbol={a} size={26} />
              <span className="w-full truncate text-center text-2xs font-semibold text-night-ink-2">{a}</span>
            </div>
          ))}
        </div>
        <div className="js-readout mt-4 rounded-lg border border-night-line bg-night/60 p-3 sm:mt-5 sm:p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="font-display text-2xl font-bold text-night-ink sm:text-3xl">
              Long <span className="text-mint">{EX.asset}</span>
            </span>
            <span className="text-sm text-night-ink-2">
              <span className="num js-notional text-night-ink">{usd(EX.collateral)}</span> at work
            </span>
          </div>
          <div className="mt-1 text-2xs text-night-ink-2">
            from <span className="num">{usd(EX.collateral)}</span> of fees already in × {EX.leverage}
          </div>
          <div className="mt-4">
            <div className="flex items-baseline justify-between text-2xs tracking-wide text-night-ink-2 uppercase">
              <span>Leverage</span>
              <span className="js-levval num text-lg font-semibold tracking-normal text-night-ink normal-case">1x</span>
            </div>
            <div className="relative mt-2 h-2 rounded-full border border-night-line bg-night/80">
              <div className="js-levfill absolute inset-0 origin-left scale-x-0 rounded-full bg-gradient-to-r from-step-3 to-mint" />
              <div className="js-levthumb absolute top-1/2 left-0 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-night bg-mint shadow-[0_0_0_4px_rgba(140,232,176,0.18)]" />
            </div>
            <div className="num mt-1.5 flex justify-between text-2xs text-night-ink-2">
              <span>1x</span>
              <span>{EX.leverage}x</span>
            </div>
          </div>
        </div>
      </Plate>
      </div>
    </Frame>
  );
}

/*
 * One move on NVDA, read as cause and effect on a shared time axis: the asset
 * line on top crosses a take-profit, a guide drops to the coin's chart below,
 * and the coin prints a big green candle as the buyback hits its pool.
 */
const PUMP_N = 18;
const PUMP_TPS = [5, 11];
const PUMP_LINE = walk(PUMP_N, 0.0035, 0.008, 11);
const PUMP_CANDLES = (() => {
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out: { open: number; close: number; high: number; low: number; tp: boolean }[] = [];
  let price = 100;
  for (let i = 0; i < PUMP_N; i++) {
    const tp = PUMP_TPS.includes(i);
    const open = price;
    // between take-profits nobody is trading: the candles barely have a body
    const close = tp ? open * 1.16 : open * (1 + rnd() * 0.005);
    const high = Math.max(open, close) * (1 + Math.abs(rnd()) * 0.004);
    const low = Math.min(open, close) * (1 - Math.abs(rnd()) * 0.004);
    out.push({ open, close, high, low, tp });
    price = close;
  }
  return out;
})();
/* traders' volume, close to nothing; the buyback is the only bar worth the name */
const PUMP_VOL = PUMP_CANDLES.map((c, i) => (c.tp ? 1 : [0.07, 0.04, 0.09, 0.03, 0.05][i % 5]));
const pumpX = (i: number) => (i + 0.5) / PUMP_N;

function Pump(props: SlideProps) {
  const DRAW = 3.6;
  const tpAt = (i: number) => 0.9 + DRAW * pumpX(i);
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.4)
      .from(q(".js-art"), { autoAlpha: 0, x: -80, duration: 2.4, ease: "power2.out" }, 0.9)
      .fromTo(q(".js-pump-reveal"), { attr: { width: 0 } }, { attr: { width: 400 }, duration: DRAW, ease: "none" }, 0.9);
    count(t, q(".js-move")[0], 0, EX.pump, (n) => `+${n.toFixed(1)}%`, 0.9, DRAW);
    // the coin's candles print as time passes; the take-profit ones land with a jolt
    q(".js-candle").forEach((c, i) => {
      if (PUMP_CANDLES[i].tp) t.from(c, { scaleY: 0, transformOrigin: "50% 100%", duration: 0.35, ease: "back.out(2.4)" }, tpAt(i) + 0.25);
      else t.from(c, { autoAlpha: 0, duration: 0.15 }, tpAt(i));
    });
    q(".js-vol").forEach((v, i) => t.from(v, { scaleY: 0, transformOrigin: "50% 100%", duration: 0.25 }, tpAt(i) + (PUMP_CANDLES[i].tp ? 0.25 : 0)));
    PUMP_TPS.forEach((idx, k) => {
      const at = tpAt(idx);
      t.from(q(".js-tp-mark")[k], { scale: 0, autoAlpha: 0, transformOrigin: "50% 100%", duration: 0.3, ease: "back.out(3)" }, at)
        .fromTo(q(".js-guide")[k], { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: "power2.in" }, at)
        .from(q(".js-buy")[k], { y: 6, autoAlpha: 0, duration: 0.3 }, at + 0.35);
      const n = PUMP_TPS.length;
      count(t, q(".js-pnl")[0], (EX.profit * k) / n, (EX.profit * (k + 1)) / n, (v) => `+${usd(v)}`, at, 0.4);
      count(t, q(".js-buyback")[0], (EX.buyback * k) / n, (EX.buyback * (k + 1)) / n, usd, at + 0.3, 0.4);
    });
  });

  const W = 400;
  const LH = 90;
  const CH = 120;
  const lLo = Math.min(...PUMP_LINE);
  const lHi = Math.max(...PUMP_LINE);
  const ly = (v: number) => 6 + (1 - (v - lLo) / (lHi - lLo)) * (LH - 12);
  const linePts = PUMP_LINE.map((v, i) => `${i === 0 ? "M" : "L"}${(pumpX(i) * W).toFixed(1)},${ly(v).toFixed(1)}`).join("");
  const cLo = Math.min(...PUMP_CANDLES.map((c) => c.low));
  // headroom above the last candle for its buyback label
  const cHi = Math.max(...PUMP_CANDLES.map((c) => c.high)) * 1.1;
  const cy = (v: number) => 4 + (1 - (v - cLo) / (cHi - cLo)) * (CH - 8);
  const bodyW = (W / PUMP_N) * 0.58;
  const perTp = EX.buyback / PUMP_TPS.length;

  return (
    <Frame
      scope={scope}
      title={`${EX.asset} rips.`}
      accent="The token gets bought."
      body={`The position takes its profit and ${PROFIT_SPLIT_PCT.buyback}% of it buys the token on its own pool, then burns it. Nobody has to be trading for that to happen.`}
    >
      {/* the bull charges in along with the move and stops on the plate's top edge */}
      <div className="relative w-full max-w-[560px] min-[360px]:mt-16 lg:mt-0">
        <div className="js-art pointer-events-none absolute right-4 bottom-[calc(100%-18px)] z-10 w-[30%] max-w-[280px] text-mint/90 max-[359px]:hidden sm:right-6 sm:bottom-[calc(100%-34px)] sm:w-[48%] lg:w-[36%]">
          <EngravedArt name="bull" />
        </div>
        <Plate>
          <div className="flex items-center gap-2 pt-1">
            <AssetIcon symbol={EX.asset} size={20} />
            <span className="text-sm font-semibold text-night-ink">{EX.asset}</span>
            <span className="js-move num text-sm font-semibold text-night-up">+0.0%</span>
          </div>

          <div className="relative mt-2">
            {/* guides: one per take-profit, dropping from the asset to the coin */}
            {PUMP_TPS.map((idx) => (
              <span
                key={idx}
                aria-hidden
                className="js-guide absolute top-0 bottom-0 w-px origin-top border-l border-dashed border-mint/40"
                style={{ left: `${pumpX(idx) * 100}%` }}
              />
            ))}

            <div className="relative h-[64px] sm:h-[90px]">
              <svg viewBox={`0 0 ${W} ${LH}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
                <defs>
                  <clipPath id="pump-reveal">
                    <rect className="js-pump-reveal" x="0" y="0" width={W} height={LH} />
                  </clipPath>
                </defs>
                <path clipPath="url(#pump-reveal)" d={linePts} fill="none" stroke="#6fe3a1" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </svg>
              {PUMP_TPS.map((idx) => (
                <span
                  key={idx}
                  className="absolute -translate-x-1/2 -translate-y-full"
                  style={{ left: `${pumpX(idx) * 100}%`, top: `${(ly(PUMP_LINE[idx]) / LH) * 100}%` }}
                >
                  <span className="js-tp-mark flex flex-col items-center">
                    <span className="num rounded-full border border-mint/40 bg-night px-1.5 py-px text-[10px] font-semibold text-mint">TP</span>
                    <span className="mt-0.5 size-1.5 rounded-full bg-mint" />
                  </span>
                </span>
              ))}
            </div>

            <div className="relative flex items-center justify-between bg-night-2 py-2 text-sm">
              <span className="font-semibold text-night-ink">The token</span>
              <span className="text-2xs text-night-ink-2">bought at every take-profit</span>
            </div>

            <div className="relative h-[90px] sm:h-[120px]">
              <svg viewBox={`0 0 ${W} ${CH}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
                {PUMP_CANDLES.map((c, i) => {
                  const x = pumpX(i) * W;
                  const up = c.close >= c.open;
                  const colour = c.tp ? "#8ce8b0" : up ? "rgba(140,232,176,0.85)" : "rgba(255,138,122,0.85)";
                  return (
                    <g key={i} className="js-candle">
                      <line x1={x} x2={x} y1={cy(c.high)} y2={cy(c.low)} stroke={colour} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      <rect
                        x={x - bodyW / 2}
                        width={bodyW}
                        y={cy(Math.max(c.open, c.close))}
                        height={Math.max(1.5, Math.abs(cy(c.open) - cy(c.close)))}
                        fill={colour}
                      />
                    </g>
                  );
                })}
              </svg>
              {/* the outer span positions, the inner one animates: GSAP's transform would drop the centring */}
              {PUMP_TPS.map((idx) => (
                <span
                  key={idx}
                  className="absolute -translate-x-1/2 -translate-y-[calc(100%+6px)]"
                  style={{ left: `${pumpX(idx) * 100}%`, top: `${(cy(PUMP_CANDLES[idx].high) / CH) * 100}%` }}
                >
                  <span className="js-buy num block rounded-md bg-mint px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-night">
                    +{usd(perTp)}
                  </span>
                </span>
              ))}
            </div>

            <div className="mt-1.5 flex items-end gap-2">
              <svg viewBox={`0 0 ${W} 26`} className="h-[22px] min-w-0 flex-1 sm:h-[28px]" preserveAspectRatio="none" aria-hidden>
                {PUMP_VOL.map((v, i) => (
                  <rect
                    key={i}
                    className="js-vol"
                    x={pumpX(i) * W - bodyW / 2}
                    width={bodyW}
                    y={26 - v * 26}
                    height={v * 26}
                    fill={PUMP_CANDLES[i].tp ? "#8ce8b0" : "rgba(159,196,173,0.55)"}
                  />
                ))}
              </svg>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-2xs text-night-ink-2">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-[2px] bg-night-ink-2/60" /> Traders&apos; volume
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-[2px] bg-mint" /> Buyback
              </span>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-night-line bg-night/60 px-3 py-2">
              <div className="text-2xs text-night-ink-2">Position profit, {EX.leverage}x</div>
              <div className="js-pnl num text-lg font-semibold text-night-up">+$0</div>
            </div>
            <div className="rounded-lg border border-night-line bg-night/60 px-3 py-2">
              <div className="text-2xs text-night-ink-2">Buyback &amp; burn</div>
              <div className="js-buyback num text-lg font-semibold text-mint">$0</div>
            </div>
          </div>
        </Plate>
      </div>
    </Frame>
  );
}

/*
 * The mirror of the pump: NVDA falls, the position is liquidated, and the
 * token's candles below carry on as quietly as before. The guide at the liquidation
 * drops to the coin and finds nothing to sell.
 */
const DUMP_N = 24;
const DUMP_LINE = walk(DUMP_N, -0.0055, 0.008, 29);
/* isolated margin at 20x gives out a few percent below the entry */
const DUMP_LIQ = Math.max(3, DUMP_LINE.findIndex((v) => v <= 97));
const DUMP_CANDLES = (() => {
  let seed = 13;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out: { open: number; close: number; high: number; low: number }[] = [];
  let price = 100;
  for (let i = 0; i < DUMP_N; i++) {
    const open = price;
    const close = open * (1 + rnd() * 0.012);
    const high = Math.max(open, close) * (1 + Math.abs(rnd()) * 0.01);
    const low = Math.min(open, close) * (1 - Math.abs(rnd()) * 0.01);
    out.push({ open, close, high, low });
    price = close;
  }
  return out;
})();
const dumpX = (i: number) => (i + 0.5) / DUMP_N;

function Dump(props: SlideProps) {
  const DRAW = 3.6;
  const atX = (i: number) => 0.9 + DRAW * dumpX(i);
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.4)
      .from(q(".js-art"), { autoAlpha: 0, x: 80, duration: 2.4, ease: "power2.out" }, 0.9)
      .fromTo(q(".js-dump-reveal"), { attr: { width: 0 } }, { attr: { width: 400 }, duration: DRAW, ease: "none" }, 0.9);
    count(t, q(".js-move")[0], 0, -EX.dump, (n) => `${n.toFixed(1)}%`, 0.9, DRAW);
    q(".js-candle").forEach((c, i) => t.from(c, { autoAlpha: 0, duration: 0.15 }, atX(i)));
    const liq = atX(DUMP_LIQ);
    t.from(q(".js-liq-mark"), { scale: 0, autoAlpha: 0, transformOrigin: "50% 100%", duration: 0.3, ease: "back.out(3)" }, liq)
      .fromTo(q(".js-liq-guide"), { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: "power2.in" }, liq)
      .from(q(".js-nosell"), { y: 6, autoAlpha: 0, duration: 0.3 }, liq + 0.35);
    count(t, q(".js-lost")[0], 0, EX.collateral, (n) => `−${usd(n)}`, liq, 0.4);
  });

  const W = 400;
  const LH = 90;
  const CH = 120;
  const lLo = Math.min(...DUMP_LINE);
  const lHi = Math.max(...DUMP_LINE);
  const ly = (v: number) => 6 + (1 - (v - lLo) / (lHi - lLo)) * (LH - 12);
  const linePts = DUMP_LINE.map((v, i) => `${i === 0 ? "M" : "L"}${(dumpX(i) * W).toFixed(1)},${ly(v).toFixed(1)}`).join("");
  const cLo = Math.min(...DUMP_CANDLES.map((c) => c.low)) * 0.97;
  const cHi = Math.max(...DUMP_CANDLES.map((c) => c.high)) * 1.03;
  const cy = (v: number) => 4 + (1 - (v - cLo) / (cHi - cLo)) * (CH - 8);
  const bodyW = (W / DUMP_N) * 0.58;

  return (
    <Frame
      scope={scope}
      title={`${EX.asset} dumps.`}
      accent="The engine sells nothing."
      body="The position can only lose the fees it was given. The engine never sells the token, so its chart keeps going where its traders take it."
    >
      {/* the bear charges in from the other side and stops on the plate's top edge */}
      <div className="relative w-full max-w-[560px] min-[360px]:mt-12 lg:mt-0">
        <div className="js-art pointer-events-none absolute right-4 bottom-[calc(100%-12px)] z-10 w-[36%] max-w-[320px] text-mint/90 max-[359px]:hidden sm:right-6 sm:bottom-[calc(100%-22px)] sm:w-[56%] lg:w-[42%]">
          <EngravedArt name="bear" />
        </div>
        <Plate>
          <div className="flex items-center gap-2 pt-1">
            <AssetIcon symbol={EX.asset} size={20} />
            <span className="text-sm font-semibold text-night-ink">{EX.asset}</span>
            <span className="js-move num text-sm font-semibold text-night-down">0.0%</span>
          </div>

          <div className="relative mt-2">
            <span
              aria-hidden
              className="js-liq-guide absolute top-0 bottom-0 w-px origin-top border-l border-dashed border-night-down/50"
              style={{ left: `${dumpX(DUMP_LIQ) * 100}%` }}
            />

            <div className="relative h-[64px] sm:h-[90px]">
              <svg viewBox={`0 0 ${W} ${LH}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
                <defs>
                  <clipPath id="dump-reveal">
                    <rect className="js-dump-reveal" x="0" y="0" width={W} height={LH} />
                  </clipPath>
                </defs>
                <path clipPath="url(#dump-reveal)" d={linePts} fill="none" stroke="#ff8a7a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </svg>
              <span
                className="absolute -translate-x-1/2 -translate-y-full"
                style={{ left: `${dumpX(DUMP_LIQ) * 100}%`, top: `${(ly(DUMP_LINE[DUMP_LIQ]) / LH) * 100}%` }}
              >
                <span className="js-liq-mark flex flex-col items-center">
                  <span className="num rounded-full border border-night-down/50 bg-night px-1.5 py-px text-[10px] font-semibold text-night-down">LIQ</span>
                  <span className="mt-0.5 size-1.5 rounded-full bg-night-down" />
                </span>
              </span>
            </div>

            <div className="relative flex items-center justify-between bg-night-2 py-2 text-sm">
              <span className="font-semibold text-night-ink">The token</span>
              <span className="text-2xs text-night-ink-2">no forced selling</span>
            </div>

            <div className="relative h-[90px] sm:h-[120px]">
              <svg viewBox={`0 0 ${W} ${CH}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
                {DUMP_CANDLES.map((c, i) => {
                  const x = dumpX(i) * W;
                  const colour = c.close >= c.open ? "rgba(140,232,176,0.85)" : "rgba(255,138,122,0.85)";
                  return (
                    <g key={i} className="js-candle">
                      <line x1={x} x2={x} y1={cy(c.high)} y2={cy(c.low)} stroke={colour} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      <rect
                        x={x - bodyW / 2}
                        width={bodyW}
                        y={cy(Math.max(c.open, c.close))}
                        height={Math.max(1.5, Math.abs(cy(c.open) - cy(c.close)))}
                        fill={colour}
                      />
                    </g>
                  );
                })}
              </svg>
              <span
                className="absolute -translate-x-1/2 -translate-y-[calc(100%+6px)]"
                style={{ left: `${dumpX(DUMP_LIQ) * 100}%`, top: `${(cy(DUMP_CANDLES[DUMP_LIQ].high) / CH) * 100}%` }}
              >
                <span className="js-nosell num block rounded-md border border-night-line bg-night px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-night-ink">
                  0 tokens sold
                </span>
              </span>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-night-line bg-night/60 px-3 py-2">
              <div className="text-2xs text-night-ink-2">Position lost, {EX.leverage}x</div>
              <div className="js-lost num text-lg font-semibold text-night-down">−$0</div>
            </div>
            <div className="rounded-lg border border-night-line bg-night/60 px-3 py-2">
              <div className="text-2xs text-night-ink-2">Tokens sold by the engine</div>
              <div className="num text-lg font-semibold text-mint">0</div>
            </div>
          </div>
        </Plate>
      </div>
    </Frame>
  );
}

/*
 * The mark taken apart: each half arrow flies in along the slash, the way its own
 * bet pays, and the two lock into the logo with a name on each.
 */
const SIDES = [
  { key: "short", name: "Short", when: "wins when it falls", assets: ["XAU", "TSLA", "ETH"] },
  { key: "long", name: "Long", when: "wins when it rises", assets: ["NVDA", "BTC", "SPY"] },
] as const;

function Start(props: SlideProps) {
  const router = useRouter();
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-ctas"), { y: 14, autoAlpha: 0, duration: 0.6 }, 0.9)
      .from(q(".js-rosette"), { scale: 0.7, autoAlpha: 0, rotate: -40, duration: 1.6, ease: "expo.out" }, 0.2)
      .from(q(".js-short"), { xPercent: 16, yPercent: -40, autoAlpha: 0, duration: 1, ease: "expo.out" }, 0.5)
      .from(q(".js-long"), { xPercent: -16, yPercent: 40, autoAlpha: 0, duration: 1, ease: "expo.out" }, 0.8)
      .from(q(".js-side"), { y: 12, autoAlpha: 0, duration: 0.5, stagger: 0.15 }, 1.2);
  });

  const exploreMarket = () => {
    props.onClose();
    router.push("/market");
  };

  return (
    <Frame
      scope={scope}
      title="Bet on any market."
      accent="In either direction."
      keepBody
      body={
        <>
          Stocks, crypto, gold, indices. Launch a long if it goes up, a short if it goes down: when the call is right,
          the profit buys the token.
          <span className="js-ctas mt-7 flex flex-wrap items-center gap-3">
            <Link
              href="/launch"
              onClick={(e) => {
                e.preventDefault();
                props.onClose();
                router.push("/launch");
              }}
              className="inline-flex h-12 items-center rounded-xl bg-mint px-6 text-md font-semibold text-night transition-transform hover:-translate-y-px active:translate-y-0"
            >
              Launch a token
            </Link>
            <button
              type="button"
              onClick={exploreMarket}
              className="inline-flex h-12 items-center rounded-xl border border-night-line px-6 text-md font-semibold text-night-ink transition-colors hover:border-night-ink-2"
            >
              Explore the market
            </button>
          </span>
        </>
      }
    >
      <div className="w-full max-w-[520px]">
        <div className="relative mx-auto flex aspect-square w-full max-w-[200px] items-center justify-center max-lg:[@media(max-height:720px)]:max-w-[120px] lg:max-w-[400px]">
          <div className="js-rosette absolute inset-0 text-mint/25">
            <Guilloche teeth={27} reach={0.95} rings={6} size={460} spin={70} className="w-full" />
          </div>
          <span className="js-short absolute w-[78%]">
            <LogoMark tone="night" optical="display" half="down" className="size-auto w-full" />
          </span>
          <span className="js-long absolute w-[78%]">
            <LogoMark tone="night" optical="display" half="up" className="size-auto w-full" />
          </span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:gap-3 lg:mt-8">
          {SIDES.map((side) => (
            <div key={side.key} className="js-side min-w-0 rounded-xl border border-night-line bg-night-2 px-3 py-2.5 sm:px-4 sm:py-3">
              <div className="flex items-center justify-between gap-2">
                <span className={cn("font-display text-xl font-bold sm:text-2xl", side.key === "long" ? "text-mint" : "text-night-ink")}>
                  <span aria-hidden>{side.key === "long" ? "↑" : "↓"}</span> {side.name}
                </span>
                <span className="flex -space-x-1.5 max-[359px]:hidden">
                  {side.assets.map((symbol) => (
                    <AssetIcon key={symbol} symbol={symbol} size={22} />
                  ))}
                </span>
              </div>
              <div className="mt-0.5 text-2xs text-night-ink-2 sm:text-sm">{side.when}</div>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

export const SLIDES = [
  { key: "intro", label: "Intro", seconds: 5.5, Component: Intro },
  { key: "wild", label: "The gap", seconds: 8.5, Component: Wild },
  { key: "bet", label: "The perp", seconds: 7, Component: Bet },
  { key: "pump", label: "Pump", seconds: 8, Component: Pump },
  { key: "dump", label: "Dump", seconds: 8, Component: Dump },
  { key: "start", label: "Start", seconds: 0, Component: Start },
] as const;
