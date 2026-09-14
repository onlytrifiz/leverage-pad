"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { cn } from "cn";
import { fmtUsd, fmtInt, fmtPrice, fmtPct, fmtSignedUsd, fmtMark } from "@/lib/format";

/**
 * A figure that moves when the underlying number moves.
 *
 * These pages re-fetch every 20–30 seconds and the old build simply swapped the
 * text: a market cap that had climbed and one that had collapsed looked exactly
 * the same — instant, silent, unnoticed. Tweening the value makes the change
 * itself legible, which on a page about burns and PnL is information rather
 * than decoration.
 *
 * The formatter is named, not passed: server components render most of these
 * figures, and a function cannot cross that boundary. Naming them also gives
 * the site one formatting vocabulary instead of an inline closure per call.
 *
 * The formatted string is a derived MotionValue rendered straight into the
 * span, so the tween never touches React state — sixty renders a second per
 * figure, on a page that can hold twenty of them, is not a trade worth making.
 */
const FORMATTERS = {
  usd: fmtUsd,
  signedUsd: fmtSignedUsd,
  int: fmtInt,
  price: fmtPrice,
  mark: fmtMark,
  pct: fmtPct,
  plain: (n: number) => String(Math.round(n)),
} as const;

export type NumberFormat = keyof typeof FORMATTERS;

export function AnimatedNumber({
  value,
  format = "int",
  className,
  duration = 0.9,
  countOnMount = false,
}: {
  value: number | null | undefined;
  format?: NumberFormat;
  className?: string;
  duration?: number;
  /** count up from zero the first time it is seen — headline aggregates only */
  countOnMount?: boolean;
}) {
  const fmt = FORMATTERS[format];
  const reduced = useReducedMotion();
  const motionValue = useMotionValue(value ?? 0);
  const text = useTransform(motionValue, (v) => fmt(v));
  const settled = useRef(false);

  useEffect(() => {
    if (value == null) return;
    /*
     * The first pass runs after hydration, so counting up from zero here cannot
     * mismatch the server render — which starting the value at zero would.
     */
    if (!settled.current) {
      settled.current = true;
      if (!countOnMount || reduced) {
        motionValue.set(value);
        return;
      }
      motionValue.set(0);
    }
    if (reduced) {
      motionValue.set(value);
      return;
    }
    const controls = animate(motionValue, value, {
      duration,
      ease: [0.22, 0.61, 0.36, 1],
    });
    return () => controls.stop();
  }, [value, reduced, duration, countOnMount, motionValue]);

  if (value == null) return <span className={className}>—</span>;
  return <motion.span className={cn("tabular-nums", className)}>{text}</motion.span>;
}
