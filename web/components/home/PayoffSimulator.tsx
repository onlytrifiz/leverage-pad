"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "cn";
import { useMarkets } from "@/components/markets-provider";
import AssetIcon from "@/components/AssetIcon";
import { fmtChange, fmtMark, fmtSignedUsd, fmtUsd } from "@/lib/format";
import { FEE_PRESETS, FEE_SPLIT_PCT } from "@/lib/doppler";

/**
 * The asymmetry, as an instrument you can push.
 *
 * Inputs are the launch's own parameters (asset, side, leverage, fee) plus a
 * volume to give the fees a size. The chart's x-axis is the asset's move and it
 * is also the control: drag across it. Two curves answer the only question that
 * matters, "what reaches the coin":
 *
 *   position P&L  = collateral × leverage × move, floored at −collateral
 *                   (isolated margin: a liquidation loses the posted fees, never more)
 *   buyback       = 75% of a positive P&L, zero otherwise
 *
 * and a third fact that does not move at all: coins sold by the engine, 0.
 *
 * It is a model of one take-profit at the chosen move and says so under the
 * chart; funding, trading costs and the tranche schedule are left out on
 * purpose so the shape stays readable.
 */

const ASSETS = ["NVDA", "BTC", "ETH", "XAU", "SPY"];
const LEVERAGES = [2, 3, 5, 10, 20, 25, 50];
const BUYBACK_SHARE = 0.75;
const MOVE_MAX = 30;
/* volume slider: log scale from $10k to $2M */
const VOL_MIN = Math.log10(10_000);
const VOL_MAX = Math.log10(2_000_000);

/*
 * The chart is drawn at its real pixel width (measured), not scaled from a
 * fixed viewBox: scaled down to a phone, 11px labels would print at 5px.
 */
const H = 280;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 22;
const PAD_B = 28;

function Chip({
  active,
  onClick,
  children,
  tone = "brand",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "brand" | "up" | "down";
}) {
  const on = { brand: "border-brand bg-brand text-white", up: "border-up bg-up text-white", down: "border-down bg-down text-white" }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors",
        active ? on : "border-line bg-panel text-ink-2 hover:border-line-2 hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-xs font-medium text-ink-3">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export default function PayoffSimulator() {
  const reduced = useReducedMotion();
  const { markets } = useMarkets();
  const [asset, setAsset] = useState("NVDA");
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState(10);
  const [feeBps, setFeeBps] = useState<number>(200);
  const [volLog, setVolLog] = useState(Math.log10(110_000));
  const [move, setMove] = useState(8);
  const svgRef = useRef<SVGSVGElement>(null);
  const [W, setW] = useState(640);
  const dragging = useRef(false);
  const moveId = useId();
  const volId = useId();

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const volume = Math.round(Math.pow(10, volLog) / 1000) * 1000;
  const fees = (volume * feeBps) / 10_000;
  const collateral = (fees * FEE_SPLIT_PCT.engine) / 100;
  const notional = collateral * lev;
  const dir = side === "long" ? 1 : -1;

  const pnlAt = (m: number) => Math.max(-collateral, notional * dir * (m / 100));
  const buybackAt = (m: number) => Math.max(0, pnlAt(m)) * BUYBACK_SHARE;

  const pnl = pnlAt(move);
  const buyback = buybackAt(move);
  const liquidated = pnl <= -collateral + 1e-9 && collateral > 0;

  const live = markets.find((m) => m.symbol === asset);
  const today = live?.change24h ?? null;
  const maxLev = live?.maxLeverage ?? null;

  /* chart geometry: y spans the worst case (−collateral) to the best (+30% at this leverage) */
  const yMax = Math.max(notional * (MOVE_MAX / 100), 1);
  const yMin = -collateral;
  const x = (m: number) => PAD_L + ((m + MOVE_MAX) / (MOVE_MAX * 2)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B);

  const { pnlPath, buybackPath, buybackArea } = useMemo(() => {
    const pts = Array.from({ length: 121 }, (_, i) => -MOVE_MAX + i * 0.5);
    const line = (f: (m: number) => number) =>
      pts.map((m, i) => `${i ? "L" : "M"}${x(m).toFixed(1)},${y(f(m)).toFixed(1)}`).join("");
    const bb = line(buybackAt);
    return {
      pnlPath: line(pnlAt),
      buybackPath: bb,
      buybackArea: `${bb}L${x(MOVE_MAX).toFixed(1)},${y(0).toFixed(1)}L${x(-MOVE_MAX).toFixed(1)},${y(0).toFixed(1)}Z`,
    };
    // the curves depend on every input that shapes x/y
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collateral, notional, dir, W]);

  const setFromPointer = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const m = Math.round((t * MOVE_MAX * 2 - MOVE_MAX) * 2) / 2;
    setMove(m);
  };

  const markerX = x(move);
  const markerY = y(buyback > 0 ? buyback : pnl);
  const spring = reduced ? { duration: 0 } : { type: "spring" as const, stiffness: 420, damping: 36 };

  return (
    <div className="frame-engraved grid grid-cols-1 overflow-hidden rounded-[18px] bg-panel lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      {/* controls */}
      <div className="space-y-5 border-b border-line p-5 sm:p-6 lg:border-r lg:border-b-0">
        <Field label="Asset">
          {ASSETS.map((a) => (
            <Chip
              key={a}
              active={asset === a}
              onClick={() => {
                setAsset(a);
                // the simulator never shows a leverage the venue would refuse
                const cap = markets.find((m) => m.symbol === a)?.maxLeverage;
                if (cap != null && lev > cap) setLev([...LEVERAGES].reverse().find((l) => l <= cap) ?? LEVERAGES[0]);
              }}
            >
              <AssetIcon symbol={a} size={14} />
              {a}
            </Chip>
          ))}
        </Field>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-1">
          <Field label="Side">
            <Chip active={side === "long"} onClick={() => setSide("long")} tone="up">
              Long
            </Chip>
            <Chip active={side === "short"} onClick={() => setSide("short")} tone="down">
              Short
            </Chip>
          </Field>
          <Field label="Trading fee">
            {FEE_PRESETS.map((f) => (
              <Chip key={f.bps} active={feeBps === f.bps} onClick={() => setFeeBps(f.bps)}>
                {f.label}
              </Chip>
            ))}
          </Field>
        </div>
        <Field label="Leverage">
          {LEVERAGES.filter((l) => maxLev == null || l <= maxLev).map((l) => (
            <Chip key={l} active={lev === l} onClick={() => setLev(l)}>
              <span className="num">{l}x</span>
            </Chip>
          ))}
        </Field>
        <div>
          <label htmlFor={volId} className="mb-2 flex items-baseline justify-between text-xs font-medium text-ink-3">
            <span>Volume traded on the coin</span>
            <span className="num text-sm font-semibold text-ink">{fmtUsd(volume)}</span>
          </label>
          <input
            id={volId}
            type="range"
            min={VOL_MIN}
            max={VOL_MAX}
            step={0.01}
            value={volLog}
            onChange={(e) => setVolLog(Number(e.target.value))}
            className="range-brand w-full"
          />
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-line bg-line">
          {[
            { k: "Fees collected", v: fmtUsd(fees) },
            { k: `Position, ${FEE_SPLIT_PCT.engine}% of fees × ${lev}`, v: fmtUsd(notional) },
          ].map((r) => (
            <div key={r.k} className="min-w-0 bg-panel px-3 py-2.5">
              <dt className="truncate text-2xs text-ink-3">{r.k}</dt>
              <dd className="num mt-0.5 text-base font-semibold text-ink">{r.v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* the chart is the slider */}
      <div className="min-w-0 p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-ink-3">
              <AssetIcon symbol={asset} size={16} />
              <span>
                If {asset} moves{" "}
                <span className={cn("num font-semibold", move >= 0 ? "text-up" : "text-down")}>
                  {fmtChange(move, 1)}
                </span>
              </span>
            </div>
            <div className="mt-1 font-display text-4xl leading-none font-bold tracking-[-0.03em] text-ink sm:text-5xl">
              {buyback > 0 ? fmtUsd(buyback) : "$0"}
              <span className="ml-2 align-middle text-base font-semibold tracking-normal text-ink-3">buys the coin back</span>
            </div>
          </div>
          <dl className="flex gap-6 text-right">
            <div>
              <dt className="text-2xs text-ink-3">Position P&amp;L</dt>
              <dd className={cn("num text-lg font-semibold", pnl >= 0 ? "text-up" : "text-down")}>
                {fmtSignedUsd(pnl)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs text-ink-3">Coins sold by the engine</dt>
              <dd className="num text-lg font-semibold text-ink">0</dd>
            </div>
          </dl>
        </div>

        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          className="mt-5 block w-full cursor-ew-resize touch-none select-none"
          role="presentation"
          onPointerDown={(e) => {
            dragging.current = true;
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setFromPointer(e.clientX);
          }}
          onPointerMove={(e) => dragging.current && setFromPointer(e.clientX)}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
        >
          <defs>
            <pattern id="sim-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(15,107,63,0.28)" strokeWidth="1" />
            </pattern>
          </defs>

          {/* loss floor: what a liquidation costs, and nothing below it */}
          <line x1={PAD_L} x2={W - PAD_R} y1={y(yMin)} y2={y(yMin)} stroke="var(--color-down)" strokeOpacity={0.35} strokeDasharray="2 4" />
          <text x={W - PAD_R} y={y(yMin) - 6} textAnchor="end" className="fill-down text-[11px]">
            worst case: the fees, {fmtUsd(collateral)}
          </text>

          {/* zero: where a typical launchpad's holders sit in every scenario */}
          <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} stroke="var(--color-line-2)" />
          <text x={PAD_L} y={y(0) - 6} className="fill-ink-3 text-[11px]">
            typical launchpad: nothing comes back
          </text>

          <path d={buybackArea} fill="url(#sim-hatch)" />
          <path d={pnlPath} fill="none" stroke="var(--color-ink-3)" strokeWidth={1.5} strokeDasharray="5 5" />
          <path d={buybackPath} fill="none" stroke="var(--color-brand)" strokeWidth={3} strokeLinejoin="round" />

          {/* today's real move of the chosen asset, from the Lighter feed */}
          {today != null && Math.abs(today) <= MOVE_MAX && (
            <g>
              <line x1={x(today)} x2={x(today)} y1={PAD_T} y2={H - PAD_B} stroke="var(--color-ink-2)" strokeOpacity={0.45} strokeDasharray="1 3" />
              <text
                x={x(today) + (today > 15 ? -6 : 6)}
                y={PAD_T + 4}
                textAnchor={today > 15 ? "end" : "start"}
                className="fill-ink-2 text-[11px]"
              >
                {asset} today {fmtChange(today, 1)}
              </text>
            </g>
          )}
          {[-30, -15, 0, 15, 30].map((m) => (
            <text
              key={m}
              x={x(m)}
              y={H - PAD_B + 16}
              textAnchor={m === -30 ? "start" : m === 30 ? "end" : "middle"}
              className="fill-ink-3 text-[11px]"
            >
              {m > 0 ? `+${m}%` : `${m}%`}
            </text>
          ))}

          <motion.line
            initial={false}
            animate={{ x1: markerX, x2: markerX }}
            transition={spring}
            y1={PAD_T}
            y2={H - PAD_B}
            stroke="var(--color-ink)"
            strokeOpacity={0.25}
          />
          <motion.circle
            initial={false}
            animate={{ cx: markerX, cy: markerY }}
            transition={spring}
            r={7}
            fill="var(--color-panel)"
            stroke={buyback > 0 ? "var(--color-brand)" : "var(--color-down)"}
            strokeWidth={3}
          />
        </svg>

        <label htmlFor={moveId} className="sr-only">
          {asset} move
        </label>
        <input
          id={moveId}
          type="range"
          min={-MOVE_MAX}
          max={MOVE_MAX}
          step={0.5}
          value={move}
          onChange={(e) => setMove(Number(e.target.value))}
          className="range-brand mt-1 w-full"
        />

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-ink-3">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <span className="h-[3px] w-4 rounded-full bg-brand" /> Buyback &amp; burn, 75% of profit
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0 w-4 border-t-[1.5px] border-dashed border-ink-3" /> Position P&amp;L
            </span>
          </span>
          {live && (
            <span className="num">
              {asset} {fmtMark(live.mark)}
            </span>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          {liquidated
            ? "At this move the position is liquidated: the fees it held are gone, the coin and its pool are not touched. The next fees open a fresh position."
            : "Illustration of one take-profit at the chosen move. Funding, trading costs and the take-profit schedule are left out."}
        </p>
      </div>
    </div>
  );
}
