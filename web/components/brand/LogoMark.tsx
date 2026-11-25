import { cn } from "cn";

/**
 * The mark: a half arrow down and a half arrow up, the same shape turned by 180 degrees,
 * with the cover's slash as the gap between them. Short and long.
 *
 * Each shaft is engraved lines that swell until they fuse into the head. Fine lines need
 * room, so the drawing has optical sizes: three lines for UI, four from 64px up.
 *
 * It is one logo on two papers: ivory and mint at night, ink and green on light. The viewBox
 * is cropped to the mark, so the rendered size is the mark's own size.
 */
const SHAPE = {
  ui: "M194.6 -420.0L367.4 -70.0L209.4 -70.0L57.4 -70.0ZM57.8 -71.0L108.5 -71.0L-108.3 420.0L-134.6 420.0ZM108.5 -71.0L159.2 -71.0L-45.5 420.0L-71.8 420.0ZM159.2 -71.0L209.8 -71.0L17.4 420.0L-9.0 420.0Z",
  display: "M194.6 -420.0L367.4 -70.0L209.4 -70.0L57.4 -70.0ZM57.8 -71.0L95.8 -71.0L-121.7 420.0L-134.6 420.0ZM95.8 -71.0L133.8 -71.0L-75.4 420.0L-88.3 420.0ZM133.8 -71.0L171.8 -71.0L-29.0 420.0L-41.9 420.0ZM171.8 -71.0L209.8 -71.0L17.4 420.0L4.4 420.0Z",
};

export function LogoMark({
  tone = "light",
  optical = "ui",
  half,
  className,
}: {
  /** the paper it sits on */
  tone?: "light" | "night";
  optical?: keyof typeof SHAPE;
  /** draw one arrow only, in its place, for the two to be animated apart */
  half?: "up" | "down";
  className?: string;
}) {
  const d = SHAPE[optical];
  return (
    <svg viewBox="-440 -440 880 880" aria-hidden focusable="false" className={cn("size-7 shrink-0", className)}>
      {half !== "up" && <path d={d} transform="rotate(180)" className={tone === "night" ? "fill-night-ink" : "fill-ink"} />}
      {half !== "down" && <path d={d} className={tone === "night" ? "fill-mint" : "fill-step-3"} />}
    </svg>
  );
}
