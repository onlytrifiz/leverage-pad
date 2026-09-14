import { cn } from "cn";

/**
 * One source of truth for page width and gutters.
 *
 * Five files each carried their own `mx-auto w-full max-w-[1200px] px-4`, and
 * the home grid quietly used 1680 — so the logo in the header did not line up
 * with the content underneath it on the one page most people land on.
 *
 * `page`  — reading widths: token detail, stats, launch, docs.
 * `wide`  — the three-column market view.
 */
export function Container({
  width = "page",
  className,
  ...props
}: React.ComponentProps<"div"> & { width?: "page" | "wide" }) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 sm:px-5",
        width === "page" ? "max-w-[1200px]" : "max-w-[1680px]",
        className
      )}
      {...props}
    />
  );
}

/** Page title block: eyebrow, heading, one line of lede. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  lede?: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-4", className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 text-sm text-ink-3">{eyebrow}</div>}
        <h1 className="text-4xl font-bold">{title}</h1>
        {lede && <p className="mt-3 max-w-[560px] text-base leading-relaxed text-ink-2">{lede}</p>}
      </div>
      {aside}
    </div>
  );
}
