"use client";

import { motion } from "motion/react";
import { cn } from "cn";

/**
 * Bars that grow into place when their group scrolls into view.
 *
 * The in-view trigger sits on the group, never on a bar: a bar starts at
 * scaleX 0, which has no area, and an observer on a box with no area does not
 * fire reliably. The group propagates the state through variants. Reduced
 * motion is handled by the site's MotionConfig, which drops the transform.
 */

const group = { hidden: {}, shown: { transition: { staggerChildren: 0.06 } } };
const grow = {
  hidden: { scaleX: 0 },
  shown: { scaleX: 1, transition: { duration: 0.9, ease: [0.16, 1, 0.3, 1] as const } },
};

export function BarGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      variants={group}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: "-40px" }}
    >
      {children}
    </motion.div>
  );
}

/** A bar `frac` of its track wide, growing from `from`. */
export function Bar({ frac, from = "left", className }: { frac: number; from?: "left" | "right"; className?: string }) {
  const w = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <motion.span
      variants={grow}
      aria-hidden
      className={cn("block h-full rounded-full", from === "left" ? "origin-left" : "ml-auto origin-right", className)}
      style={{ width: `${w}%` }}
    />
  );
}
