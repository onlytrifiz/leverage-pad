import { cn } from "cn";
import { Panel } from "./panel";
import { AnimatedNumber, type NumberFormat } from "@/components/motion";

/**
 * The figure grid that appears on every page — market cap, fees, burns, buckets.
 * It was copy-pasted six times as `panel grid grid-cols-2 gap-px overflow-hidden
 * bg-line` with the cell markup inline, which is why the columns, the label size
 * and the value size had drifted apart between pages.
 *
 * `gap-px` over a `bg-border` panel is what draws the hairlines: the gaps are the
 * rules, so there is no border to double up at the edges.
 */
export function StatGrid({
  className,
  cols = 4,
  ...props
}: React.ComponentProps<"div"> & { cols?: 2 | 3 | 4 | 6 }) {
  return (
    <Panel
      data-slot="stat-grid"
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden bg-border",
        cols === 3 && "sm:grid-cols-3",
        cols === 4 && "sm:grid-cols-4",
        cols === 6 && "sm:grid-cols-3 lg:grid-cols-6",
        className
      )}
      {...props}
    />
  );
}

export function Stat({
  label,
  value,
  amount,
  format,
  countOnMount,
  hint,
  tone = "ink",
  mono = true,
  size = "md",
  className,
  children,
}: {
  label: React.ReactNode;
  /** already-formatted value; use `amount` + `format` instead to make it move */
  value?: React.ReactNode;
  /** the raw figure — rendered through `AnimatedNumber` so refreshes are visible */
  amount?: number | null;
  format?: NumberFormat;
  countOnMount?: boolean;
  hint?: React.ReactNode;
  tone?: "ink" | "up" | "down" | "brand";
  mono?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  children?: React.ReactNode;
}) {
  const valueClass = cn(
    "mt-1 truncate font-semibold",
    size === "lg" && "text-2xl",
    size === "md" && "text-xl",
    size === "sm" && "text-base",
    mono && "num",
    tone === "ink" && "text-ink",
    tone === "up" && "text-up",
    tone === "down" && "text-down",
    tone === "brand" && "text-brand"
  );

  return (
    <div data-slot="stat" className={cn("min-w-0 bg-card px-4 py-3.5 sm:px-5 sm:py-4", className)}>
      <div className="truncate text-xs text-ink-3">{label}</div>
      {children ??
        (format ? (
          <div className={valueClass}>
            <AnimatedNumber value={amount} format={format} countOnMount={countOnMount} />
          </div>
        ) : (
          <div className={valueClass}>{value}</div>
        ))}
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}
