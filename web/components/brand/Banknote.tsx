"use client";

import { useId, useMemo } from "react";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import { cn } from "cn";
import AssetIcon from "@/components/AssetIcon";
import { EngravedArt } from "./EngravedArt";
import { Guilloche } from "./Guilloche";

/**
 * A coin, printed as the banknote it is.
 *
 * Every element is one a real note carries, and each is bound to the coin
 * rather than decorating it:
 *
 *   vignette     the token's own logo, as a note carries its sovereign; the animal
 *                stands under the denomination, the bull for a long, the bear for a
 *                short. Without a logo the animal takes the vignette.
 *   engine       the asset's mark and a struck tablet, up and green or down and red
 *   denomination the leverage, struck in hatched type inside a rosette
 *   serials      the token address, top left and bottom right, in red as on
 *                the paper money everyone has held
 *   foil stripe  an iridescent security band that shifts with the tilt
 *   microprint   the claim, too small to read from arm's length
 *
 * Sizes are container units: the note scales as one object, from the hero
 * down to a card in the market grid, with no second layout to keep in sync.
 * The tilt runs on motion values (no React state); the foil and the glare
 * are driven by the same two numbers.
 */

type Props = {
  symbol: string;
  name: string;
  market: string;
  side: "long" | "short";
  leverage: number;
  serial: string;
  /** the token's logo; absent, the animal takes its place */
  image?: string;
  /** a managed coin's note carries a stamp: its engine can be retuned by the creator */
  managed?: boolean;
  /** tilt, foil and glare follow the pointer */
  interactive?: boolean;
  className?: string;
};

/* the border chain: small rosettes stepped along the frame, as on a note's edge */
function borderRosettes(w: number, h: number, inset: number, step: number) {
  const pts: [number, number][] = [];
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  for (let x = x0; x <= x1 + 0.1; x += step) {
    pts.push([x, y0], [x, y1]);
  }
  for (let y = y0 + step; y < y1 - 0.1; y += step) {
    pts.push([x0, y], [x1, y]);
  }
  return pts;
}

function rosettePath(R: number, teeth: number) {
  const r = R / teeth;
  const d = r * 3.4;
  const k = (R - r) / r;
  let p = "";
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    p += `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  return p + "Z";
}

const W = 1000;
const H = 470;

export function Banknote({ symbol, name, market, side, leverage, serial, image, managed = false, interactive = true, className }: Props) {
  const reduced = useReducedMotion();
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const sx = useSpring(px, { stiffness: 120, damping: 16 });
  const sy = useSpring(py, { stiffness: 120, damping: 16 });
  const rotateY = useTransform(sx, [0, 1], [-11, 11]);
  const rotateX = useTransform(sy, [0, 1], [8, -8]);
  const foilY = useTransform(sx, [0, 1], ["0%", "100%"]);
  const glareX = useTransform(sx, (v) => `${v * 100}%`);
  const glareY = useTransform(sy, (v) => `${v * 100}%`);
  const glare = useMotionTemplate`radial-gradient(60% 80% at ${glareX} ${glareY}, rgba(255,255,255,0.45), transparent 60%)`;

  // several notes share a page (the market grid): the symbol id must be theirs alone
  const symbolId = `note-rosette-${useId().replace(/:/g, "")}`;
  const chain = useMemo(() => borderRosettes(W, H, 26, 22), []);
  const rosette = useMemo(() => rosettePath(9, 11), []);

  const short = shortAddr(serial);
  const art = side === "short" ? "bear" : "bull";
  const isShort = side === "short";
  // the ticker is set to its length: a note never prints half a name
  const tickerSize = Math.max(2.6, Math.min(7.4, 31 / ((symbol.length + 1) * 0.6)));

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || reduced || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
  };
  const onLeave = () => {
    px.set(0.5);
    py.set(0.5);
  };

  return (
    <div className={cn("[perspective:1600px]", className)} onPointerMove={onMove} onPointerLeave={onLeave}>
      <motion.div
        style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
        className="banknote group/note relative aspect-[1000/470] w-full overflow-hidden rounded-[1.6cqw] text-ink [container-type:inline-size]"
      >
        {/* the engraved frame and its rosette chain, one svg in note units */}
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <symbol id={symbolId} viewBox="-10 -10 20 20" overflow="visible">
              <path d={rosette} fill="none" stroke="currentColor" strokeWidth="0.45" />
            </symbol>
          </defs>
          <rect x="10" y="10" width={W - 20} height={H - 20} rx="12" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="2" />
          <rect x="42" y="42" width={W - 84} height={H - 84} rx="6" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1" />
          <g opacity="0.55">
            {chain.map(([x, y], i) => (
              <use key={i} href={`#${symbolId}`} x={x - 10} y={y - 10} width="20" height="20" />
            ))}
          </g>
        </svg>

        {/* vignette: the token's logo in an engraved oval with a sunburst */}
        <div className="absolute top-[13%] left-[6.5%] flex h-[74%] w-[33%] items-center justify-center overflow-hidden rounded-[50%] border-[0.2cqw] border-current/45">
          <div aria-hidden className="note-sunburst absolute inset-0" />
          {image ? (
            // the creator's file on the project's gateway, any size and any format: nothing for the optimiser
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt=""
              className="relative aspect-square w-[66%] rounded-full object-cover shadow-[0_0_0_0.5cqw_#eef6f0,0_0_0_0.7cqw_rgba(12,52,32,0.55)]"
            />
          ) : (
            <EngravedArt name={art} className="relative w-[96%] text-ink" />
          )}
        </div>

        {/* issue */}
        <div className="absolute top-[13%] left-[42%] w-[30%]">
          <div className="text-[1.25cqw] font-semibold tracking-[0.3em] text-ink-2 uppercase">multiply.cash</div>
          <div className="mt-[1.4cqw] flex h-[7cqw] items-center font-display leading-none font-bold tracking-[-0.03em] whitespace-nowrap" style={{ fontSize: `${tickerSize}cqw` }}>
            ${symbol}
          </div>
          <div className="mt-[0.5cqw] truncate text-[1.7cqw] text-ink-2">{name}</div>
          <div className="mt-[2.1cqw] text-[1.25cqw] tracking-[0.18em] text-ink-3 uppercase">Its fees trade</div>
          <div className="mt-[0.9cqw] flex items-center gap-[1cqw]">
            <span className="flex size-[4.6cqw] shrink-0 [&>*]:!h-full [&>*]:!w-full [&>*]:!text-[2cqw]">
              <AssetIcon symbol={market} size={64} />
            </span>
            <span className="min-w-0 truncate font-display text-[3cqw] leading-none font-bold">{market}</span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-[0.5cqw] rounded-[0.6cqw] px-[1.1cqw] py-[0.65cqw] font-display text-[2.9cqw] leading-none font-bold text-white uppercase",
                isShort ? "bg-[#b3261e]" : "bg-[#0f6b3f]"
              )}
            >
              <svg viewBox="0 0 12 14" className="h-[2.2cqw] w-[1.9cqw]" aria-hidden>
                <path d="M6 0l6 7H8v7H4V7H0z" fill="currentColor" transform={isShort ? "rotate(180 6 7)" : undefined} />
              </svg>
              {side}
            </span>
          </div>
          <div className="note-microprint mt-[2cqw] overflow-hidden text-[0.85cqw] leading-none tracking-[0.12em] whitespace-nowrap text-ink-3 uppercase">
            tokens fueled by perps tokens fueled by perps tokens fueled by perps tokens fueled by perps
          </div>
        </div>

        {/* the foil: an iridescent security band that moves with the tilt */}
        <motion.div
          aria-hidden
          className="note-foil absolute top-0 bottom-0 left-[73.5%] w-[6.5%]"
          style={{ backgroundPositionY: foilY }}
        >
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 [writing-mode:vertical-rl] text-[1.1cqw] font-bold tracking-[0.4em] text-ink/40 uppercase">
            multiply
          </span>
        </motion.div>

        {/* denomination: the leverage, hatched inside its rosette */}
        <div className="absolute top-[14%] right-[4.5%] flex aspect-square w-[17%] items-center justify-center">
          <div className="absolute inset-0 text-ink/45">
            <Guilloche teeth={17 + leverage} reach={0.6} rings={3} size={200} spin={90} className="h-full w-full" />
          </div>
          <span className="note-hatch relative font-display text-[7cqw] leading-none font-bold tracking-[-0.04em]">
            {leverage}x
          </span>
        </div>
        {image && (
          <div aria-hidden className="absolute right-[4.6%] bottom-[12.5%] flex h-[32%] w-[15.5%] items-end justify-center text-ink">
            <EngravedArt name={art} className="w-full" />
          </div>
        )}

        {/* serials, in red as on real paper money */}
        <span className="num absolute top-[5.4%] left-[5.2%] text-[1.35cqw] tracking-[0.08em] text-down/85">{short}</span>
        <span className="num absolute right-[5.2%] bottom-[5.2%] text-[1.35cqw] tracking-[0.08em] text-down/85">{short}</span>

        {managed && (
          <span className="absolute bottom-[12.5%] left-[42%] -rotate-6 rounded-[0.5cqw] border-[0.25cqw] border-double border-down/80 px-[1cqw] py-[0.3cqw] text-[1.3cqw] font-bold tracking-[0.3em] text-down/85 uppercase">
            Managed
          </span>
        )}

        {/* glare: the lamp catching the paper */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 mix-blend-soft-light transition-opacity duration-300 group-hover/note:opacity-100 motion-reduce:hidden"
          style={{ background: glare }}
        />
      </motion.div>
    </div>
  );
}

function shortAddr(a: string) {
  if (!a.startsWith("0x") || a.length < 12) return a.toUpperCase();
  return `${a.slice(2, 6)} ${a.slice(6, 10)} ${a.slice(-4)}`.toUpperCase();
}
