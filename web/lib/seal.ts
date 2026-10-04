/**
 * The coin seal as a static SVG string, for token metadata.
 *
 * `components/brand/Guilloche.tsx` draws the same figure on the page with a slow
 * rotation; that component uses motion hooks and cannot run on the server. The
 * geometry here is identical (hypotrochoid, same radii, same ring falloff), so
 * the image pinned to IPFS is the seal people see on the site, frozen.
 */

const BRAND = "#0f6b3f";
const PAPER = "#f2f6f2";

function hypotrochoid(R: number, r: number, d: number, phase: number, steps: number) {
  const k = (R - r) / r;
  let path = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 + phase;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    path += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  return path + "Z";
}

/**
 * How far a seal's lobes reach, from the coin's take-profit: on a log scale, so +20% / +50% /
 * +100% land close to the shapes the old safe / balanced / degen profiles had, and anything past
 * +150% reaches all the way.
 */
export function sealReach(takeProfitPct: number) {
  const t = (Math.log(Math.max(10, takeProfitPct)) - Math.log(10)) / (Math.log(150) - Math.log(10));
  return Math.max(0.15, Math.min(1, t));
}

export function sealSvg({
  leverage,
  side,
  takeProfitPct,
  symbol,
  rings = 4,
  size = 512,
}: {
  leverage: number;
  side: "long" | "short";
  takeProfitPct: number;
  symbol: string;
  rings?: number;
  size?: number;
}): string {
  const R = 100;
  const teeth = Math.max(13, Math.min(47, Math.round(17 + leverage)));
  const r = R / teeth;
  const d = r * (3.0 + sealReach(takeProfitPct) * 1.1);
  // a short's seal runs anticlockwise on the page; frozen, that is a mirrored rosette
  const flip = side === "short" ? "scale(-1,1)" : "";
  const outer = Array.from({ length: rings }, (_, i) => {
    const k = 1 - i * 0.07;
    const path = hypotrochoid(R * k, r * k, d * k, (i * Math.PI) / (teeth * 2), 3000);
    return `<path d="${path}" fill="none" stroke="${BRAND}" stroke-width="0.4" opacity="${(0.62 - i * 0.07).toFixed(2)}" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const ri = 46 / 13;
  const inner = hypotrochoid(46, ri, ri * 3.2, 0, 2000);
  const label = symbol.replace(/[<>&"]/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-112 -112 224 224" width="${size}" height="${size}">` +
    `<rect x="-112" y="-112" width="224" height="224" fill="${PAPER}"/>` +
    `<g transform="${flip}">${outer}` +
    `<path d="${inner}" fill="none" stroke="${BRAND}" stroke-width="0.35" opacity="0.3" vector-effect="non-scaling-stroke"/></g>` +
    `<text x="0" y="6" text-anchor="middle" font-family="Familjen Grotesk, Helvetica, Arial, sans-serif" font-size="18" font-weight="600" fill="#0c3420">$${label}</text>` +
    `</svg>`
  );
}
