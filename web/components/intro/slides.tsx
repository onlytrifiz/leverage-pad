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
 * The seven chapters of the intro.
 *
 * One worked example runs through all of them so the numbers add up from
 * chapter to chapter: $110,000 of volume at a 2% fee is $2,200 of fees, the
 * engine's 80% is $1,760 of collateral, at 10x that is a $17,600 position, an
 * 8% move on NVDA is $1,408 of profit and 75% of it, $1,056, buys the coin back.
 * Every plate that shows those figures says it is an example.
 *
 * Each chapter is one GSAP timeline built in `useChapter`. The shell pauses it
 * while a finger is held down and jumps it to the end under reduced motion.
 */

export type SlideProps = { paused: boolean; reduced: boolean; onClose: () => void };

const EX = {
  volume: 110_000,
  feePct: 2,
  get fees() {
    return (this.volume * this.feePct) / 100;
  },
  get collateral() {
    return (this.fees * FEE_SPLIT_PCT.engine) / 100;
  },
  leverage: 10,
  get notional() {
    return this.collateral * this.leverage;
  },
  pump: 8,
  get profit() {
    return (this.notional * this.pump) / 100;
  },
  get buyback() {
    return this.profit * 0.75;
  },
  dump: 12,
};

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");

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
  body,
  children,
}: {
  scope: React.RefObject<HTMLDivElement | null>;
  title: string;
  accent: string;
  body: React.ReactNode;
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
        </h2>
        <p className="js-body mt-3 max-w-[44ch] text-[15px] leading-relaxed text-night-ink-2 sm:mt-6 sm:text-lg">
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

/** a polyline through `values`, scaled into a w×h box */
function linePath(values: number[], w: number, h: number, pad = 4, lo?: number, hi?: number) {
  const min = lo ?? Math.min(...values);
  const max = hi ?? Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
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
      <h2 className="relative text-center font-display text-[clamp(40px,8vw,118px)] leading-[0.98] font-bold tracking-[-0.035em]">
        <span className="block text-night-ink">
          <Words text="Every launchpad takes a fee." />
        </span>
        <span className="js-line2 mt-2 block text-mint">
          {/* own words: they rise after the first line has landed */}
          {"Here, the fee trades.".split(" ").map((w, i, a) => (
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

const TICKETS = [
  { side: "Buy", amount: 12_400 },
  { side: "Sell", amount: 3_800 },
  { side: "Buy", amount: 26_500 },
  { side: "Buy", amount: 9_200 },
  { side: "Sell", amount: 41_000 },
  { side: "Buy", amount: 17_100 },
] as const;

function Fee(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    const rows = q(".js-ticket");
    const fill = q(".js-fill")[0];
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.3);
    let acc = 0;
    rows.forEach((row, i) => {
      const fee = (TICKETS[i].amount * EX.feePct) / 100;
      const before = acc;
      acc += fee;
      const at = 0.9 + i * 0.55;
      t.from(row, { x: -18, autoAlpha: 0, duration: 0.4 }, at)
        .fromTo(
          row.querySelector(".js-fee"),
          { color: "#6fe3a1", scale: 1.25 },
          { color: "#9fc4ad", scale: 1, duration: 0.6 },
          at + 0.2
        )
        .to(fill, { scaleY: acc / EX.fees, duration: 0.45, ease: "power2.out" }, at + 0.25);
      count(t, q(".js-collateral")[0], (before * FEE_SPLIT_PCT.engine) / 100, (acc * FEE_SPLIT_PCT.engine) / 100, usd, at + 0.25, 0.45);
    });
  });

  return (
    <Frame
      scope={scope}
      title="Every swap pays a fee."
      accent="It goes to work."
      body={
        <>
          1 to 5% on every buy and sell, settled in USDG. {FEE_SPLIT_PCT.engine}% of it goes straight into a
          leveraged position that the coin owns.
        </>
      }
    >
      <Plate>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-5 sm:gap-8">
          <ul className="space-y-2">
            {TICKETS.map((tk, i) => (
              <li
                key={i}
                className={cn(
                  "js-ticket flex items-center justify-between gap-3 rounded-lg border border-night-line bg-night/60 px-3 py-2",
                  i > 3 && "max-sm:hidden"
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={cn(
                      "w-9 shrink-0 text-2xs font-semibold tracking-wide uppercase",
                      tk.side === "Buy" ? "text-night-up" : "text-night-down"
                    )}
                  >
                    {tk.side}
                  </span>
                  <span className="num truncate text-sm text-night-ink">
                    {int(tk.amount)}
                    <span className="max-[359px]:hidden"> USDG</span>
                  </span>
                </span>
                <span className="js-fee num inline-block shrink-0 text-sm text-night-ink-2">
                  +{usd((tk.amount * EX.feePct) / 100)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col items-center gap-2">
            <span className="text-2xs tracking-wide text-night-ink-2 uppercase">Position</span>
            <div className="relative h-[200px] w-[72px] overflow-hidden rounded-[14px] border border-night-line bg-night/60 sm:h-[260px] sm:w-[88px]">
              <div className="js-fill absolute inset-x-0 bottom-0 h-full origin-bottom scale-y-0 bg-gradient-to-t from-step-3 to-mint" />
              <div className="absolute inset-0 bg-[repeating-linear-gradient(-45deg,rgba(6,26,16,0.25)_0_1px,transparent_1px_6px)]" />
            </div>
            <span className="js-collateral num text-lg font-semibold text-night-ink">$0</span>
          </div>
        </div>
      </Plate>
    </Frame>
  );
}

const ASSETS = ["BTC", "ETH", "SOL", "SPY", "XAU", "QQQ", "ANTHROPIC", "NVDA"];
const LEVERAGES = [2, 3, 5, 10, 20];

function Bet(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    const tiles = q(".js-tile");
    const chips = q(".js-lev");
    const lit = { borderColor: "#8ce8b0", backgroundColor: "rgba(140,232,176,0.14)" };
    const dim = { borderColor: "#1d4430", backgroundColor: "rgba(6,26,16,0.6)" };
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.3);
    // a scanner pass over the menu, landing on the last tile: NVDA
    tiles.forEach((tile, i) => {
      const at = 1 + i * 0.13;
      t.to(tile, { ...lit, duration: 0.08 }, at);
      if (i < tiles.length - 1) t.to(tile, { ...dim, duration: 0.25 }, at + 0.13);
    });
    t.from(q(".js-readout"), { y: 12, autoAlpha: 0, duration: 0.5 }, 2.2);
    chips.forEach((chip, i) => {
      const at = 2.6 + i * 0.22;
      t.to(chip, { ...lit, color: "#e9f6ee", duration: 0.1 }, at);
      if (LEVERAGES[i] !== EX.leverage) t.to(chip, { ...dim, color: "#9fc4ad", duration: 0.2 }, at + 0.22);
    });
    count(t, q(".js-notional")[0], EX.collateral, EX.notional, usd, 3.6, 1.1);
  });

  return (
    <Frame
      scope={scope}
      title="Pointed at an asset."
      accent="With leverage."
      body="The creator picks the market, long or short, the leverage up to 50x and when each deposit takes profit."
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
              Long <span className="text-mint">NVDA</span>
            </span>
            <span className="text-sm text-night-ink-2">
              <span className="num js-notional text-night-ink">{usd(EX.collateral)}</span> at work
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {LEVERAGES.map((l) => (
              <span
                key={l}
                className="js-lev num rounded-md border border-night-line bg-night/60 px-2.5 py-1 text-sm text-night-ink-2"
              >
                {l}x
              </span>
            ))}
          </div>
        </div>
      </Plate>
    </Frame>
  );
}

const PUMP_LINE = walk(40, 0.0021, 0.006, 11);
const COIN_FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6];

function Pump(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-art"), { autoAlpha: 0, x: 30, duration: 1.2 }, 0.9)
      .from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.4)
      .from(q(".js-asset-line"), { drawSVG: 0, duration: 2, ease: "power1.inOut" }, 0.9);
    count(t, q(".js-move")[0], 0, EX.pump, (n) => `+${n.toFixed(1)}%`, 0.9, 2);
    count(t, q(".js-pnl")[0], 0, EX.profit, (n) => `+${usd(n)}`, 1.4, 1.8);
    t.from(q(".js-coin-line"), { drawSVG: 0, duration: 2.2, ease: "power1.inOut" }, 2.6);
    q(".js-burn").forEach((b, i) => t.from(b, { scale: 0, autoAlpha: 0, transformOrigin: "50% 50%", duration: 0.35, ease: "back.out(3)" }, 3.2 + i * 0.6));
    count(t, q(".js-buyback")[0], 0, EX.buyback, usd, 3.1, 1.6);
  });

  const W = 400;
  return (
    <Frame
      scope={scope}
      title="NVDA rips."
      accent="The coin gets bought."
      body="The position takes its profit and 75% of it buys the coin on its own pool, then burns it. The chart climbs even with no new buyers."
    >
      {/* the bull stands on the plate's top edge, a vignette rather than a backdrop */}
      <div className="relative w-full max-w-[560px] min-[360px]:mt-16 lg:mt-0">
        <div className="js-art pointer-events-none absolute right-4 bottom-[calc(100%-18px)] z-10 w-[30%] max-w-[280px] text-mint/90 max-[359px]:hidden sm:right-6 sm:bottom-[calc(100%-34px)] sm:w-[48%]">
          <EngravedArt name="bull" />
        </div>
      <Plate>
        <div className="flex items-center gap-2 pt-1">
          <AssetIcon symbol="NVDA" size={20} />
          <span className="text-sm font-semibold text-night-ink">NVDA</span>
          <span className="js-move num text-sm font-semibold text-night-up">+0.0%</span>
        </div>
        <svg viewBox={`0 0 ${W} 90`} className="mt-2 h-[64px] w-full sm:h-[90px]" preserveAspectRatio="none" aria-hidden>
          <path className="js-asset-line" d={linePath(PUMP_LINE, W, 90)} fill="none" stroke="#6fe3a1" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-night-line bg-night/60 px-3 py-2">
            <div className="text-2xs text-night-ink-2">Position profit, 10x</div>
            <div className="js-pnl num text-lg font-semibold text-night-up">+$0</div>
          </div>
          <div className="rounded-lg border border-night-line bg-night/60 px-3 py-2">
            <div className="text-2xs text-night-ink-2">Buyback &amp; burn</div>
            <div className="js-buyback num text-lg font-semibold text-mint">$0</div>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="font-semibold text-night-ink">The coin</span>
          <span className="text-2xs text-night-ink-2">bought back in three take-profits</span>
        </div>
        <svg viewBox={`0 0 ${W} 80`} className="mt-1 h-[56px] w-full overflow-visible sm:h-[80px]" preserveAspectRatio="none" aria-hidden>
          <path className="js-coin-line" d={linePath(COIN_FLAT, W, 80, 10, 0, 4)} fill="none" stroke="#8ce8b0" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="relative -mt-[56px] h-[56px] sm:-mt-[80px] sm:h-[80px]">
          {[12, 20, 27].map((idx) => (
            <span
              key={idx}
              className="js-burn absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-mint ring-4 ring-mint/25"
              style={{
                left: `${(idx / (COIN_FLAT.length - 1)) * 100}%`,
                top: `${(10 + (1 - COIN_FLAT[idx] / 4) * 60) / 0.8}%`,
              }}
            />
          ))}
        </div>
      </Plate>
      </div>
    </Frame>
  );
}

const DUMP_LINE = walk(40, -0.0034, 0.006, 29);
const COIN_HOLD = Array.from({ length: 40 }, () => 1);

function Dump(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-art"), { autoAlpha: 0, y: 16, duration: 1.2 }, 0.9)
      .from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.4)
      .from(q(".js-asset-line"), { drawSVG: 0, duration: 2, ease: "power1.inOut" }, 0.9)
      .from(q(".js-coin-line"), { drawSVG: 0, duration: 2, ease: "power1.inOut" }, 0.9);
    count(t, q(".js-move")[0], 0, -EX.dump, (n) => `${n.toFixed(1)}%`, 0.9, 2);
    t.from(q(".js-fact"), { y: 10, autoAlpha: 0, duration: 0.45, stagger: 0.25 }, 2.8);
  });

  const W = 400;
  return (
    <Frame
      scope={scope}
      title="NVDA dumps."
      accent="Nothing sells the coin."
      body="The position can only lose the fees it was given, money other launchpads keep for themselves anyway. Holders' tokens and the pool are never touched."
    >
      <div className="relative w-full max-w-[560px] min-[360px]:mt-12 lg:mt-0">
        <div className="js-art pointer-events-none absolute right-4 bottom-[calc(100%-12px)] z-10 w-[36%] max-w-[320px] text-mint/90 max-[359px]:hidden sm:right-6 sm:bottom-[calc(100%-22px)] sm:w-[56%]">
          <EngravedArt name="bear" />
        </div>
      <Plate>
        <div className="flex items-center gap-2 pt-1">
          <AssetIcon symbol="NVDA" size={20} />
          <span className="text-sm font-semibold text-night-ink">NVDA</span>
          <span className="js-move num text-sm font-semibold text-night-down">0.0%</span>
        </div>
        <div className="relative mt-2">
          <svg viewBox={`0 0 ${W} 120`} className="h-[96px] w-full sm:h-[130px]" preserveAspectRatio="none" aria-hidden>
            <path className="js-asset-line" d={linePath(DUMP_LINE, W, 120)} fill="none" stroke="#ff8a7a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <path className="js-coin-line" d={linePath(COIN_HOLD, W, 120, 4, -1, 1.7)} fill="none" stroke="#8ce8b0" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          </svg>
          <span className="absolute top-0 right-0 text-2xs font-semibold text-mint">The coin, flat</span>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            ["Coins sold by the engine", "0"],
            ["Pool liquidity", "Locked"],
            ["At risk", "Fees only"],
          ].map(([k, v]) => (
            <div key={k} className="js-fact flex items-baseline justify-between gap-2 rounded-lg border border-night-line bg-night/60 px-3 py-2 sm:block">
              <dt className="text-2xs text-night-ink-2">{k}</dt>
              <dd className="num text-base font-semibold text-night-ink sm:text-lg">{v}</dd>
            </div>
          ))}
        </dl>
      </Plate>
      </div>
    </Frame>
  );
}

/* compounding: two sources stacked over time, the asset's share accelerating */
const STEPS = 24;
const TRADERS = Array.from({ length: STEPS }, (_, i) => 6 + i * 1.1);
const ASSET = Array.from({ length: STEPS }, (_, i) => Math.pow(1.17, i) - 1);

function areaPath(top: number[], base: number[], w: number, h: number, max: number) {
  const x = (i: number) => (i / (top.length - 1)) * w;
  const y = (v: number) => h - (v / max) * h;
  const upper = top.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const lower = base
    .map((v, i) => [x(i), y(v)] as const)
    .reverse()
    .map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`)
    .join("");
  return `${upper}${lower}Z`;
}

function Edge(props: SlideProps) {
  const scope = useChapter(props, (t, q) => {
    t.from(q(".js-plate"), { y: 24, autoAlpha: 0, duration: 0.7 }, 0.3)
      .fromTo(q(".js-reveal"), { attr: { width: 0 } }, { attr: { width: 400 }, duration: 3.2, ease: "power1.inOut" }, 0.9)
      .from(q(".js-legend"), { autoAlpha: 0, y: 8, stagger: 0.3, duration: 0.4 }, 1.6);
  });

  const W = 400;
  const H = 220;
  const total = TRADERS.map((v, i) => v + ASSET[i]);
  const max = Math.max(...total) * 1.06;
  const zero = TRADERS.map(() => 0);

  return (
    <Frame
      scope={scope}
      title="Two engines."
      accent="One coin."
      body="People trading the coin, and the trend of the asset behind it. Pair the right asset at the right moment and the two can compound."
    >
      <Plate>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[180px] w-full sm:h-[240px]" preserveAspectRatio="none" aria-hidden>
          <defs>
            <clipPath id="edge-reveal">
              <rect className="js-reveal" x="0" y="0" width={W} height={H} />
            </clipPath>
            <pattern id="edge-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
              <rect width="6" height="6" fill="rgba(159,196,173,0.18)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(159,196,173,0.45)" strokeWidth="1" />
            </pattern>
          </defs>
          <g clipPath="url(#edge-reveal)">
            <path d={areaPath(TRADERS, zero, W, H, max)} fill="url(#edge-hatch)" />
            <path d={areaPath(total, TRADERS, W, H, max)} fill="rgba(140,232,176,0.35)" />
            <path d={linePath(total, W, H, 0, 0, max)} fill="none" stroke="#8ce8b0" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          </g>
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#1d4430" />
        </svg>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <span className="js-legend flex items-center gap-2 text-night-ink-2">
            <span className="size-3 rounded-sm border border-night-ink-2/50 bg-[repeating-linear-gradient(-45deg,rgba(159,196,173,0.5)_0_1px,transparent_1px_4px)]" />
            Buys from traders
          </span>
          <span className="js-legend flex items-center gap-2 text-night-ink">
            <span className="size-3 rounded-sm bg-mint/60" />
            Buybacks from the asset&apos;s trend
          </span>
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
  { key: "fee", label: "The fee", seconds: 7, Component: Fee },
  { key: "bet", label: "The bet", seconds: 7, Component: Bet },
  { key: "pump", label: "Pump", seconds: 8, Component: Pump },
  { key: "dump", label: "Dump", seconds: 8, Component: Dump },
  { key: "edge", label: "The edge", seconds: 8, Component: Edge },
  { key: "start", label: "Start", seconds: 0, Component: Start },
] as const;
