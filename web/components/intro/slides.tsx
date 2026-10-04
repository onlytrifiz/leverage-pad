"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import { gsap, useGSAP, EASE_OUT } from "@/lib/gsap";
import { EngravedArt } from "@/components/brand/EngravedArt";
import { Guilloche } from "@/components/brand/Guilloche";
import AssetIcon from "@/components/AssetIcon";
import { FEE_SPLIT_PCT } from "@/lib/doppler";

/**
 * The six chapters of the intro.
 *
 * One worked example runs through all of them so the numbers add up from
 * chapter to chapter: $110,000 of volume at a 2% fee is $2,200 of fees, the
 * engine's 80% is $1,760 of collateral, at 50x that is an $88,000 position, a
 * 4% move is $3,520 of profit and 75% of it, $2,640, buys the coin back. The
 * leverage is illustrative: the launch form caps each market at Lighter's own
 * limit.
 * Every plate that shows those figures says it is an example.
 *
 * Each chapter is one GSAP timeline built in `useChapter`. The shell pauses it
 * while a finger is held down and jumps it to the end under reduced motion.
 */

export type SlideProps = { paused: boolean; reduced: boolean; onClose: () => void };

const EX = {
  asset: "NVDA",
  volume: 110_000,
  feePct: 2,
  get fees() {
    return (this.volume * this.feePct) / 100;
  },
  get collateral() {
    return (this.fees * FEE_SPLIT_PCT.engine) / 100;
  },
  leverage: 50,
  get notional() {
    return this.collateral * this.leverage;
  },
  pump: 4,
  get profit() {
    return (this.notional * this.pump) / 100;
  },
  get buyback() {
    return this.profit * 0.75;
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
        <h2 className="font-display text-[clamp(34px,9.4vw,46px)] leading-[1.02] font-bold tracking-[-0.03em] text-night-ink lg:text-[clamp(44px,5.4vw,74px)]">
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
      <h2 className="relative text-center font-display text-[clamp(40px,7.4vw,104px)] leading-[0.98] font-bold tracking-[-0.035em] text-balance">
        <span className="block text-night-ink">
          <Words text="Launchpads keep the fees." />
        </span>
        <span className="js-line2 mt-2 block text-mint">
          {/* own words: they rise after the first line has landed */}
          {"Here, they pump the coin.".split(" ").map((w, i, a) => (
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

const ASSETS = ["BTC", "ETH", "SOL", "SPY", "XAU", "QQQ", "ANTHROPIC", "NVDA"];

function Bet(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    const tiles = q(".js-tile");
    const lit = { borderColor: "#8ce8b0", backgroundColor: "rgba(140,232,176,0.14)" };
    const dim = { borderColor: "#1d4430", backgroundColor: "rgba(6,26,16,0.6)" };
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.3);
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
      title="The fees open a"
      accent="leveraged"
      after="trade."
      body="Every buy and sell pays a fee in USDG. The creator points it at a market, long or short, up to 50x, and picks when each deposit takes profit."
    >
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
            from <span className="num">{usd(EX.collateral)}</span> of fees × {EX.leverage}
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
    // a slight upward drift between take-profits: the coin never bleeds while it waits
    const close = tp ? open * 1.14 : open * (1 + 0.006 + rnd() * 0.016);
    const high = Math.max(open, close) * (1 + Math.abs(rnd()) * 0.01);
    const low = Math.min(open, close) * (1 - Math.abs(rnd()) * 0.01);
    out.push({ open, close, high, low, tp });
    price = close;
  }
  return out;
})();
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
      accent="The coin gets bought."
      body="The position takes its profit and 75% of it buys the coin on its own pool, then burns it. The chart climbs even with no new buyers."
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
              <span className="font-semibold text-night-ink">The coin</span>
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
 * The mirror of the pump: NVDA falls, the 50x position is liquidated, and the
 * coin's candles below keep their slow climb. The guide at the liquidation
 * drops to the coin and finds nothing to sell.
 */
const DUMP_N = 24;
const DUMP_LIQ = 15;
const DUMP_LINE = walk(DUMP_N, -0.0055, 0.008, 29);
const DUMP_CANDLES = (() => {
  let seed = 13;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out: { open: number; close: number; high: number; low: number }[] = [];
  let price = 100;
  for (let i = 0; i < DUMP_N; i++) {
    const open = price;
    const close = open * (1 + 0.006 + rnd() * 0.018);
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
      accent="Nothing sells the coin."
      body="The position can only lose the fees it was given. The engine never sells the coin, so its chart keeps going where its traders take it."
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
              <span className="font-semibold text-night-ink">The coin</span>
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
                  0 coins sold
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
              <div className="text-2xs text-night-ink-2">Coins sold by the engine</div>
              <div className="num text-lg font-semibold text-mint">0</div>
            </div>
          </div>
        </Plate>
      </div>
    </Frame>
  );
}

/*
 * The same coin twice, on the same trading: once on its own, once with the
 * engine. Both lines share the drift; the engine's line also steps up at each
 * take-profit on a high-leverage position and hands part of it back, the rest
 * holds. The shaded gap between them is what leverage added.
 */
const EDGE_N = 64;
const EDGE_SPIKES = [
  { at: 12, jump: 0.14 },
  { at: 26, jump: 0.22 },
  { at: 39, jump: 0.18 },
  { at: 53, jump: 0.32 },
];
const { EDGE_BASE, EDGE_LINE } = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const base = [100];
  const line = [100];
  let mult = 1;
  let retrace = 0;
  let left = 0;
  for (let i = 1; i < EDGE_N; i++) {
    base.push(base[i - 1] * (1 + 0.0026 + rnd() * 0.01));
    const spike = EDGE_SPIKES.find((sp) => sp.at === i);
    if (spike) {
      mult *= 1 + spike.jump;
      retrace = (spike.jump * 0.3) / 4;
      left = 4;
    } else if (left > 0) {
      mult *= 1 - retrace;
      left--;
    }
    line.push(base[i] * mult);
  }
  return { EDGE_BASE: base, EDGE_LINE: line };
})();
const EDGE_LO = Math.min(...EDGE_BASE) * 0.97;
const EDGE_HI = Math.max(...EDGE_LINE) * 1.08;
const EDGE_ALONE = (EDGE_BASE[EDGE_N - 1] / EDGE_BASE[0] - 1) * 100;
const EDGE_WITH = (EDGE_LINE[EDGE_N - 1] / EDGE_LINE[0] - 1) * 100;

function Edge(props: SlideProps) {
  const DRAW = 4;
  const end = 0.9 + DRAW;
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.3).fromTo(
      q(".js-reveal"),
      { attr: { width: 0 } },
      { attr: { width: 400 }, duration: DRAW, ease: "none" },
      0.9
    );
    q(".js-tp").forEach((m, k) => {
      const at = 0.9 + (DRAW * EDGE_SPIKES[k].at) / (EDGE_N - 1);
      t.from(m, { scale: 0, autoAlpha: 0, duration: 0.3, ease: "back.out(3)" }, at);
    });
    count(t, q(".js-alone")[0], 0, EDGE_ALONE, (n) => `+${Math.round(n)}%`, 0.9, DRAW);
    count(t, q(".js-with")[0], 0, EDGE_WITH, (n) => `+${Math.round(n)}%`, 0.9, DRAW);
    t.from(q(".js-endtag"), { x: -6, autoAlpha: 0, duration: 0.35, stagger: 0.12 }, end)
      .from(q(".js-gap"), { autoAlpha: 0, y: 6, duration: 0.45 }, end + 0.2);
  });

  const W = 400;
  const H = 220;
  const xOf = (i: number) => (i / (EDGE_N - 1)) * W;
  const yOf = (v: number) => (1 - (v - EDGE_LO) / (EDGE_HI - EDGE_LO)) * H;
  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join("");
  const withLine = path(EDGE_LINE);
  const aloneLine = path(EDGE_BASE);
  const gap = `${withLine}${EDGE_BASE.map((v, i) => [xOf(i), yOf(v)] as const)
    .reverse()
    .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
    .join("")}Z`;
  const pct = (v: number) => (yOf(v) / H) * 100;
  const gapAt = 46;

  return (
    <Frame
      scope={scope}
      title="Trading moves the coin."
      accent="Leverage pumps it."
      body={`Same coin, same traders. Every take-profit on a ${EX.leverage}x position adds buys on top, and the gap keeps growing. The right asset at the right time keeps it coming.`}
    >
      <Plate>
        <div className="relative pr-12 sm:pr-14">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-[170px] w-full sm:h-[240px]" preserveAspectRatio="none" aria-hidden>
            <defs>
              <clipPath id="edge-reveal">
                <rect className="js-reveal" x="0" y="0" width={W} height={H} />
              </clipPath>
            </defs>
            <g clipPath="url(#edge-reveal)">
              <path d={gap} fill="rgba(140,232,176,0.16)" />
              <path d={aloneLine} fill="none" stroke="rgba(159,196,173,0.7)" strokeWidth={1.75} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
              <path d={withLine} fill="none" stroke="#8ce8b0" strokeWidth={2.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
            <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#1d4430" />
          </svg>

          {/* overlays share the chart's box: the right padding is room for the end tags */}
          <div className="pointer-events-none absolute inset-y-0 right-12 left-0 sm:right-14">
            {EDGE_SPIKES.map((sp) => (
              <span
                key={sp.at}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${(sp.at / (EDGE_N - 1)) * 100}%`, top: `${pct(EDGE_LINE[sp.at])}%` }}
              >
                <span className="js-tp block size-2 rounded-full bg-mint shadow-[0_0_0_3px_rgba(140,232,176,0.25)]" />
              </span>
            ))}
            <span
              className="absolute left-full ml-1.5 -translate-y-1/2"
              style={{ top: `${pct(EDGE_LINE[EDGE_N - 1])}%` }}
            >
              <span className="js-endtag num block rounded-md bg-mint px-1.5 py-0.5 text-[11px] font-semibold text-night">
                +{Math.round(EDGE_WITH)}%
              </span>
            </span>
            <span
              className="absolute left-full ml-1.5 -translate-y-1/2"
              style={{ top: `${pct(EDGE_BASE[EDGE_N - 1])}%` }}
            >
              <span className="js-endtag num block rounded-md border border-night-line bg-night px-1.5 py-0.5 text-[11px] font-semibold text-night-ink-2">
                +{Math.round(EDGE_ALONE)}%
              </span>
            </span>
            <span
              className="absolute -translate-x-1/2"
              style={{
                left: `${(gapAt / (EDGE_N - 1)) * 100}%`,
                top: `${(pct(EDGE_LINE[gapAt]) + pct(EDGE_BASE[gapAt])) / 2}%`,
              }}
            >
              <span className="js-gap block text-center text-[10px] leading-tight font-semibold whitespace-nowrap text-mint sm:text-2xs">
                buy pressure
                <br />
                from leverage
              </span>
            </span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-night-line bg-night/60 px-3 py-2">
            <div className="flex items-center gap-1.5 text-2xs text-night-ink-2">
              <span aria-hidden className="w-3 border-t border-dashed border-night-ink-2" />
              Trading alone
            </div>
            <div className="js-alone num text-lg font-semibold text-night-ink">+0%</div>
          </div>
          <div className="rounded-lg border border-mint/30 bg-mint/[0.07] px-3 py-2">
            <div className="flex items-center gap-1.5 text-2xs text-night-ink-2">
              <span aria-hidden className="w-3 border-t-2 border-mint" />
              <span className="max-[359px]:hidden">With {EX.leverage}x take-profits</span>
              <span className="min-[360px]:hidden">With leverage</span>
            </div>
            <div className="js-with num text-lg font-semibold text-mint">+0%</div>
          </div>
        </div>
      </Plate>
    </Frame>
  );
}

function Start(props: SlideProps) {
  const router = useRouter();
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-ctas"), { y: 14, autoAlpha: 0, duration: 0.6 }, 0.9).from(
      q(".js-rosette"),
      { scale: 0.7, autoAlpha: 0, rotate: -40, duration: 1.6, ease: "expo.out" },
      0.2
    );
  });

  const exploreMarket = () => {
    props.onClose();
    router.push("/market");
  };

  return (
    <Frame
      scope={scope}
      title="Pick an asset."
      accent="Launch the coin."
      keepBody
      body={
        <>
          Every coin opens at the same ~$4,000 valuation, with liquidity locked from the first block. You choose
          what its fees trade.
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
              Launch a coin
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
      <div className="js-rosette relative mx-auto flex w-full max-w-[220px] items-center justify-center text-mint/60 lg:max-w-[460px]">
        <Guilloche teeth={27} reach={0.95} rings={6} size={460} spin={70} className="w-full" />
        <div className="absolute w-[46%] text-mint/80">
          <EngravedArt name="bull" />
        </div>
      </div>
    </Frame>
  );
}

export const SLIDES = [
  { key: "intro", label: "Intro", seconds: 5.5, Component: Intro },
  { key: "bet", label: "The bet", seconds: 7, Component: Bet },
  { key: "pump", label: "Pump", seconds: 8, Component: Pump },
  { key: "dump", label: "Dump", seconds: 8, Component: Dump },
  { key: "edge", label: "The edge", seconds: 8, Component: Edge },
  { key: "start", label: "Start", seconds: 0, Component: Start },
] as const;
