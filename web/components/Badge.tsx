import { Badge } from "@/components/ui/badge";

/**
 * Project-specific pills, composed from the Badge primitive rather than
 * hand-styled spans — status chips were being rebuilt inline in five files with
 * three different paddings.
 */

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
    <Badge variant={side === "long" ? "up" : "down"}>
      {leverage}× {side} {market}
    </Badge>
  );
}

export function DemoBadge() {
  return (
    <Badge variant="secondary" className="text-ink-3">
      Demo data
    </Badge>
  );
}

export function LiveBadge({ label = "Live" }: { label?: string }) {
  return (
    <Badge variant="brand">
      <span aria-hidden className="size-1.5 rounded-full bg-brand" />
      {label}
    </Badge>
  );
}
