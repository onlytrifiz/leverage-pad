import { cn } from "cn";

/**
 * An engraved vignette, inked in whatever colour the parent sets.
 *
 * The files in /public/art are alpha masks, not pictures: the engraving's lines
 * are the only opaque pixels. Filling a box with `currentColor` through the
 * mask is what lets one bull print in forest ink on the mint paper and in mint
 * on the night of the intro, with no second asset and no filter tricks.
 *
 * Source: two Nano Banana Pro engravings, converted with sharp (trim, invert,
 * levels into the alpha channel). The aspect ratios below are those files'.
 */
const ART = {
  bull: { src: "/art/bull.webp", ratio: 1328 / 1177 },
  bear: { src: "/art/bear.webp", ratio: 1600 / 891 },
} as const;

export type ArtName = keyof typeof ART;

export function EngravedArt({
  name,
  className,
  style,
  fit = "width",
}: {
  name: ArtName;
  className?: string;
  style?: React.CSSProperties;
  /** "height": fill the parent's height instead, so arts of different shapes share one baseline */
  fit?: "width" | "height";
}) {
  const art = ART[name];
  return (
    <div
      aria-hidden
      className={cn(fit === "height" ? "h-full max-w-full" : "w-full", "bg-current", className)}
      style={{
        aspectRatio: art.ratio,
        maskImage: `url(${art.src})`,
        WebkitMaskImage: `url(${art.src})`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        ...style,
      }}
    />
  );
}
