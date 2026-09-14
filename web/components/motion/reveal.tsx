"use client";

import { motion, type Variants } from "motion/react";
import { cn } from "cn";

/**
 * Entrance motion for content blocks and lists.
 *
 * Deliberately small: 10px and a fifth of a second. On a page whose whole job
 * is showing numbers, a big slide is a delay dressed up as design — this is
 * only enough to say "this arrived", and to let a list land in reading order
 * rather than all at once.
 */

const container: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.32, ease: [0.22, 0.61, 0.36, 1] },
  },
};

/**
 * Wraps a list; children marked with <RevealItem> come in one after another.
 *
 * `trigger` matters more than it looks: an element with `display: contents`
 * has no box, so an in-view observer on it never fires and every child stays
 * at opacity 0 — which is exactly how the side rails ended up rendering empty.
 * Anything inside a scroller, or laid out with `contents`, has to use "mount".
 */
export function Reveal({
  children,
  className,
  once = true,
  trigger = "view",
  as: As = "div",
}: {
  children: React.ReactNode;
  className?: string;
  once?: boolean;
  trigger?: "view" | "mount";
  as?: "div" | "ul" | "section";
}) {
  const Comp = motion[As];
  const activation =
    trigger === "mount"
      ? { animate: "shown" as const }
      : { whileInView: "shown" as const, viewport: { once, margin: "-40px" } };
  return (
    <Comp className={className} variants={container} initial="hidden" {...activation}>
      {children}
    </Comp>
  );
}

export function RevealItem({
  children,
  className,
  as: As = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "li";
}) {
  const Comp = motion[As];
  return (
    <Comp variants={item} className={className}>
      {children}
    </Comp>
  );
}

/** A single block that rises into place on its own, without a parent list. */
export function RevealBlock({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.4, delay, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The live indicator. A dot that says "live" and does not move is a claim the
 * page never backs up; this one breathes, and stops breathing for anybody who
 * asked motion to stop.
 */
export function LivePulse({ className, tone = "up" }: { className?: string; tone?: "up" | "brand" }) {
  const colour = tone === "up" ? "bg-up" : "bg-brand";
  return (
    <span aria-hidden className={cn("relative flex size-1.5 shrink-0", className)}>
      <motion.span
        className={cn("absolute inline-flex size-full rounded-full", colour)}
        animate={{ opacity: [0.55, 0, 0.55], scale: [1, 2.6, 1] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }}
      />
      <span className={cn("relative inline-flex size-1.5 rounded-full", colour)} />
    </span>
  );
}
