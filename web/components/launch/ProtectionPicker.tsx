"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { SNIPE, SNIPE_OFF, SNIPE_PRESETS, fmtSeconds, firstBuyDopplerCostPct, type Snipe } from "@/lib/doppler";

/**
 * Launch protection: how long the fee takes to fall, and where it opens. Both go into the launch
 * and stay there, so the curve underneath is drawn from the exact numbers the router will get.
 */
export default function ProtectionPicker({
  value,
  onChange,
  feeBps,
}: {
  value: Snipe;
  onChange: (s: Snipe) => void;
  feeBps: number;
}) {
  const on = value.seconds > 0;
  const preset = SNIPE_PRESETS.some((p) => p.seconds === value.seconds);
  const [custom, setCustom] = useState("");
  const [fee, setFee] = useState(on ? value.startFee : SNIPE.defaultFee);
  const pick = (seconds: number) => onChange(seconds > 0 ? { startFee: fee, seconds } : SNIPE_OFF);
  const feeLabel = `${feeBps / 100}%`;
  const pct = ((fee - SNIPE.minFee) / (SNIPE.maxFee - SNIPE.minFee)) * 100;

  return (
    <div>
      <div role="group" aria-label="Protection window" className="flex flex-wrap items-center gap-1.5">
        {SNIPE_PRESETS.map((p) => (
          <button
            key={p.seconds}
            type="button"
            aria-pressed={value.seconds === p.seconds}
            onClick={() => {
              setCustom("");
              pick(p.seconds);
            }}
            className={`num min-h-9 rounded-full border px-3.5 text-sm transition-colors ${
              value.seconds === p.seconds
                ? "border-brand bg-brand-soft font-semibold text-brand"
                : "border-line text-ink-2 hover:border-line-2"
            }`}
          >
            {p.label}
          </button>
        ))}
        <label
          className={`flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors ${
            on && !preset ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-2"
          }`}
        >
          <input
            value={custom}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 3);
              const n = Math.min(Number(digits), SNIPE.maxSeconds);
              setCustom(digits === "" ? "" : String(n));
              if (n > 0) pick(n);
            }}
            placeholder="Custom"
            inputMode="numeric"
            aria-label={`Protection window in seconds, up to ${SNIPE.maxSeconds}`}
            className="num w-14 bg-transparent placeholder:text-ink-3 focus:outline-none"
          />
          <span className="text-xs text-ink-3">sec</span>
        </label>
      </div>

      {!on ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          Everyone pays the flat {feeLabel} from the first block. Your first buy pays only Doppler&apos;s slice,{" "}
          <span className="num">{firstBuyDopplerCostPct(feeBps, SNIPE_OFF).toFixed(2)}%</span> of the tokens.
        </p>
      ) : (
        <>
          <div className="mt-5 flex items-baseline justify-between gap-3">
            <span className="text-sm text-ink-2">Opening fee</span>
            <span className="num text-lg font-semibold text-ink">{fee / 10_000}%</span>
          </div>
          <div className="relative mx-3.5 mt-1 h-10">
            <div className="absolute top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-panel-2" />
            <div className="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-brand" style={{ width: `${pct}%` }} />
            <div
              className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-panel bg-brand"
              style={{ left: `${pct}%` }}
            />
            <input
              type="range"
              min={SNIPE.minFee}
              max={SNIPE.maxFee}
              step={50_000}
              value={fee}
              onChange={(e) => {
                const f = Number(e.target.value);
                setFee(f);
                onChange({ startFee: f, seconds: value.seconds });
              }}
              aria-label="Opening fee"
              aria-valuetext={`${fee / 10_000}%`}
              className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>
          <ProtectionCurve startPct={fee / 10_000} endPct={feeBps / 100} seconds={value.seconds} />
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            Buys and sells both pay it, and it cannot be changed after launch. It goes where the normal fee goes. Your first buy
            pays only Doppler&apos;s slice of the opening rate,{" "}
            <span className="num">{Number(firstBuyDopplerCostPct(feeBps, value).toFixed(2))}%</span> of its tokens.
            {value.seconds > 60 && " A long window also keeps real buyers out: most people will wait for it to end."}
          </p>
        </>
      )}
    </div>
  );
}

/** the schedule, drawn: the fee falling from the opening rate to the coin's fee */
function ProtectionCurve({ startPct, endPct, seconds }: { startPct: number; endPct: number; seconds: number }) {
  const W = 320;
  const H = 110;
  const top = SNIPE.maxFee / 10_000;
  const y = (v: number) => 10 + (1 - v / top) * (H - 30);
  const xEnd = W * 0.62;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-3 h-auto w-full max-w-[420px]"
      role="img"
      aria-label={`Fee falls from ${startPct}% to ${endPct}% in ${fmtSeconds(seconds)}`}
    >
      <line x1="0" y1={H - 20} x2={W} y2={H - 20} stroke="var(--color-line-2)" />
      <motion.path
        initial={false}
        animate={{ d: `M0,${y(startPct)} L${xEnd},${y(endPct)} L${W},${y(endPct)}` }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth="2.5"
      />
      <text x="4" y={Math.max(11, y(startPct) - 4)} className="fill-ink-2 text-[11px]">
        {startPct}% at launch
      </text>
      <text x={xEnd + 6} y={y(endPct) - 6} className="fill-ink-2 text-[11px]">
        {endPct}% after
      </text>
      <text x="0" y={H - 4} className="fill-ink-3 text-[10px]">
        launch
      </text>
      <text x={xEnd} y={H - 4} textAnchor="middle" className="fill-ink-3 text-[10px]">
        {fmtSeconds(seconds)}
      </text>
    </svg>
  );
}
