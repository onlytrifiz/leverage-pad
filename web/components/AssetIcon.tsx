"use client";

import { useState } from "react";

/**
 * Icona di un asset Lighter dal loro CDN pubblico: le crypto stanno su
 * `<symbol>.svg`, le stock su `<symbol>.png`. Catena di fallback: svg → png →
 * avatar a lettera (cerchio con iniziale), cosi' un simbolo nuovo non rompe mai.
 */
export default function AssetIcon({ symbol, size = 18 }: { symbol: string; size?: number }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const base = `https://assets.lighter.xyz/fe/token/${symbol.toLowerCase()}`;

  if (stage === 2) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-line-2 bg-panel-2 font-bold text-ink-2"
        style={{ width: size, height: size, fontSize: size * 0.5 }}
        aria-hidden
      >
        {symbol[0]}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={stage === 0 ? `${base}.svg` : `${base}.png`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full"
      onError={() => setStage((s) => (s === 0 ? 1 : 2))}
    />
  );
}
