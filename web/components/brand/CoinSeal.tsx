import { Guilloche } from "./Guilloche";
import { sealReach } from "@/lib/seal";

/**
 * A coin's seal.
 *
 * Every launch is an instrument, so every coin gets its own engraved rosette,
 * derived from the configuration that will never change after launch: leverage
 * sets the lobe count, the take-profit sets how far the lobes reach, and a
 * short position's seal turns anticlockwise. Two coins with the same setup share
 * a seal, which is correct - the seal describes the engine, not the ticker.
 */


export function CoinSeal({
  leverage,
  side,
  takeProfitPct,
  size = 200,
  rings = 4,
  spin = 150,
  className,
}: {
  leverage: number;
  side: "long" | "short";
  takeProfitPct: number;
  size?: number;
  rings?: number;
  spin?: number;
  className?: string;
}) {
  return (
    <Guilloche
      teeth={17 + leverage}
      reach={sealReach(takeProfitPct)}
      direction={side === "short" ? -1 : 1}
      rings={rings}
      size={size}
      spin={spin}
      className={className}
    />
  );
}
