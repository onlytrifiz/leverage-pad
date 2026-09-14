"use client";

import { useMemo } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * The guilloché rosette: the engine, drawn the way a banknote is drawn.
 *
 * Guilloché is the interference pattern engraved on currency and share
 * certificates. It is not texture borrowed for mood: it is a hypotrochoid, and
 * its shape is a pure function of the numbers fed into it. Those numbers are the
 * protocol's own, so the figure is a reading of the engine, not a picture of one.
 *
 *   teeth  ← one more lobe for every coin launched, so the rosette densifies
 *            as the protocol grows
 *   reach  ← share of coins with a live position, pushing the tracing point out
 *            until the lobes overlap and weave
 *
 * A hypotrochoid is the curve traced by a point at distance `d` from the centre
 * of a circle of radius `r` rolling inside a circle of radius `R`:
 *
 *   x = (R - r)·cos t + d·cos(((R - r) / r)·t)
 *   y = (R - r)·sin t - d·sin(((R - r) / r)·t)
 *
 * `d` well above `r` is what makes the lobes cross each other; that crossing is
 * the whole look, and it is why the first attempt (d ≈ r) came out as a plain
 * scalloped circle.
 *
 * Cost: paths are computed once per parameter change, and only a `rotate` on the
 * group animates, so the whole figure lives on the compositor.
 */

type Props = {
  /** lobe count: the rosette's identity. Callers derive it from real values. */
  teeth?: number;
  /** 0..1, how far the tracing point reaches out before the lobes weave */
  reach?: number;
  rings?: number;
  size?: number;
  className?: string;
  /** seconds for one full turn; 0 stops it */
  spin?: number;
  /** -1 turns the other way: a short position's seal runs anticlockwise */
  direction?: 1 | -1;
};

function hypotrochoid(R: number, r: number, d: number, phase: number, steps: number) {
  const k = (R - r) / r;
  let path = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 + phase;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    path += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  return path + "Z";
}

export function Guilloche({
  teeth: teethProp = 31,
  reach = 0.5,
  rings = 5,
  size = 380,
  className,
  spin = 120,
  direction = 1,
}: Props) {
  const reduced = useReducedMotion();

  const { outer, inner } = useMemo(() => {
    const R = 100;
    const teeth = Math.max(13, Math.min(47, Math.round(teethProp)));
    const r = R / teeth;
    const d = r * (3.0 + Math.max(0, Math.min(1, reach)) * 1.1);
    const outer = Array.from({ length: rings }, (_, i) => {
      const k = 1 - i * 0.07;
      return {
        d: hypotrochoid(R * k, r * k, d * k, (i * Math.PI) / (teeth * 2), 3000),
        opacity: 0.62 - i * 0.07,
      };
    });
    // a smaller counter-turning trace: two directions is what reads as machined
    const ri = 46 / 13;
    const inner = hypotrochoid(46, ri, ri * 3.2, 0, 2000);
    return { outer, inner };
  }, [teethProp, reach, rings]);

  const turning = !reduced && spin > 0;

  return (
    <svg
      viewBox="-112 -112 224 224"
      width={size}
      height={size}
      className={className}
      aria-hidden
      focusable="false"
    >
      <motion.g
        animate={turning ? { rotate: 360 * direction } : undefined}
        transition={{ duration: spin, repeat: Infinity, ease: "linear" }}
        style={{ transformOrigin: "center" }}
      >
        {outer.map((p, i) => (
          <path
            key={i}
            d={p.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.4}
            opacity={p.opacity}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </motion.g>
      <motion.g
        animate={turning ? { rotate: -360 * direction } : undefined}
        transition={{ duration: spin * 1.7, repeat: Infinity, ease: "linear" }}
        style={{ transformOrigin: "center" }}
      >
        <path
          d={inner}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.35}
          opacity={0.3}
          vectorEffect="non-scaling-stroke"
        />
      </motion.g>
    </svg>
  );
}
