"use client";

import { MotionConfig } from "motion/react";

/**
 * One motion policy for the whole site.
 *
 * `reducedMotion="user"` is the important part: the CSS in globals.css already
 * flattens keyframe and transition durations under `prefers-reduced-motion`,
 * but JavaScript-driven animation ignores that entirely — without this every
 * counter, reveal and icon would keep moving for someone who asked the system
 * to stop.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.35, ease: [0.22, 0.61, 0.36, 1] }}>
      {children}
    </MotionConfig>
  );
}
