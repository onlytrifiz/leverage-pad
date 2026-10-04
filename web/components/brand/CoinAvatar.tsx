import { cn } from "cn";

/**
 * A coin's logo as its metadata pins it: the creator's upload, or the seal generated at
 * launch. Coins without a readable image get their ticker's first letter on the brand tint,
 * never a broken frame.
 *
 * A plain <img>: the source is the project's IPFS gateway with arbitrary CIDs, small and
 * already sized by the creator, so there is nothing for the image optimiser to do.
 */
export function CoinAvatar({
  image,
  symbol,
  size = 40,
  className,
}: {
  image?: string;
  symbol: string;
  size?: number;
  className?: string;
}) {
  const box = cn("shrink-0 overflow-hidden rounded-full border border-line bg-brand-soft", className);
  if (!image) {
    return (
      <span
        aria-hidden
        className={cn(box, "flex items-center justify-center font-display font-bold text-brand")}
        style={{ width: size, height: size, fontSize: size * 0.42 }}
      >
        {symbol.slice(0, 1).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" width={size} height={size} loading="lazy" className={cn(box, "object-cover")} style={{ width: size, height: size }} />
  );
}
