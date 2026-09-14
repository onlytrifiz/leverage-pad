import { cn } from "cn";

/**
 * The project's card. White paper on the mint ground, one radius, one shadow.
 * It used to be a bare `.panel` CSS class pasted with hand-written header rows
 * in nine files; the header, the divider and the padding are part of it now, so
 * a panel cannot be assembled slightly differently on the next page.
 */
export function Panel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel"
      className={cn(
        "rounded-[14px] border border-border bg-card shadow-[0_1px_2px_rgba(12,52,32,0.04)]",
        className
      )}
      {...props}
    />
  );
}

export function PanelHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        "flex min-w-0 items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-[18px]",
        className
      )}
      {...props}
    />
  );
}

export function PanelTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="panel-title"
      className={cn("min-w-0 truncate text-md font-semibold text-ink", className)}
      {...props}
    />
  );
}

/** Small right-hand note in a panel header (source, unit, link). */
export function PanelMeta({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="panel-meta"
      className={cn("shrink-0 text-xs text-ink-3", className)}
      {...props}
    />
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="panel-body" className={cn("p-4 sm:p-5", className)} {...props} />;
}
