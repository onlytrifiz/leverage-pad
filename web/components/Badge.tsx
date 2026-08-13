export function HedgeBadge({
  side,
  market,
  leverage,
}: {
  side: "long" | "short";
  market: string;
  leverage: number;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-accent/50 bg-accent-dim/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent-bright">
      {leverage}x {side} {market}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span className="inline-flex items-center rounded border border-line-2 bg-panel-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-2">
      demo data
    </span>
  );
}

export function LiveBadge({ label = "live" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-up/40 bg-up/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-up-bright">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-up-bright" />
      {label}
    </span>
  );
}
