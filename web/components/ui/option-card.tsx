"use client";

import { cn } from "cn";

/**
 * A selectable card. The launch form built the same selected/unselected
 * treatment three times by hand (direction, market, risk) and the three had
 * already drifted; this is a radio, so keyboard and screen readers get the
 * grouping the visual gives everyone else.
 */
export function OptionCard({
  selected,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & { selected: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        "min-w-0 rounded-[14px] border bg-card px-4 py-3.5 text-left shadow-[0_1px_2px_rgba(12,52,32,0.04)] transition-colors sm:px-5 sm:py-4",
        selected
          ? "border-brand bg-brand-soft"
          : "border-border hover:border-line-2 hover:bg-muted",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function OptionGroup({
  label,
  className,
  ...props
}: React.ComponentProps<"div"> & { label: string }) {
  return <div role="radiogroup" aria-label={label} className={cn("min-w-0", className)} {...props} />;
}

/** Numbered step heading used down the launch flow. */
export function StepHeading({
  n,
  title,
  meta,
  action,
}: {
  n: number;
  title: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand"
        >
          {n}
        </span>
        <span className="min-w-0 text-base font-semibold text-ink">{title}</span>
        {meta && <span className="shrink-0 text-sm text-ink-3">{meta}</span>}
      </div>
      {action}
    </div>
  );
}
