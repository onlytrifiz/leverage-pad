import { Guilloche } from "./Guilloche";

/**
 * A coin's seal.
 *
 * Every launch is an instrument, so every coin gets its own engraved rosette,
 * derived from the configuration that will never change after launch: leverage
 * sets the lobe count, the risk profile sets how far the lobes reach, and a
 * short position's seal turns anticlockwise. Two coins with the same setup share
 * a seal, which is correct - the seal describes the engine, not the ticker.
 */

const RISK_REACH: Record<string, number> = { safe: 0.25, balanced: 0.55, degen: 0.95 };

export function CoinSeal({
  leverage,
  side,
  riskProfile,
  size = 200,
  rings = 4,
  spin = 150,
  className,
}: {
  leverage: number;
  side: "long" | "short";
  riskProfile?: string | null;
  size?: number;
  rings?: number;
  spin?: number;
  className?: string;
}) {
  return (
    <Guilloche
      teeth={17 + leverage}
      reach={RISK_REACH[riskProfile ?? "balanced"] ?? 0.55}
      direction={side === "short" ? -1 : 1}
      rings={rings}
      size={size}
      spin={spin}
      className={className}
    />
  );
}
