"use client";

import { useState } from "react";
import Image from "next/image";
import { useTokenLogos } from "@/hooks/use-token-logos";

const CDN = "https://assets.lighter.xyz/fe/token";

/**
 * Icona di un asset Lighter dal loro CDN pubblico.
 *
 * L'estensione la dichiara il venue nel tokenlist, non la si indovina: su
 * Robinhood Chain 39 mercati su 57 non hanno lo svg, e la vecchia catena
 * svg → png costava una richiesta fallita e un flicker per ognuno di quelli.
 * Finche' la mappa non e' arrivata si usa `<simbolo>.png`, che e' la forma di
 * ogni logo su questa chain: il primo tentativo e' quello giusto comunque.
 *
 * Passa da `next/image` perche' questi png sono pensati per una scheda, non per
 * un'icona da 18px: il piu' pesante (AI) e' 925KB, l'insieme dei 57 mercati
 * quasi 5MB. Ridimensionati dall'optimizer diventano irrilevanti. Gli svg
 * vengono serviti tali e quali — Next li marca `unoptimized` da solo.
 */
export default function AssetIcon({ symbol, size = 18 }: { symbol: string; size?: number }) {
  const logos = useTokenLogos();
  const [failed, setFailed] = useState(false);
  // only a ticker can become a CDN path: anything else ("?" for an unknown engine) would turn
  // into a query string, which next/image rejects by throwing during render
  const valid = /^[A-Za-z0-9._-]+$/.test(symbol ?? "");
  const entry = valid ? logos[symbol] : undefined;
  const src = entry
    ? `${CDN}/${entry.logo}.${entry.ext}`
    : `${CDN}/${symbol.toLowerCase()}.png`;

  // simbolo sconosciuto al CDN: cerchio con l'iniziale, mai un riquadro rotto
  if (failed || !valid) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-line-2 bg-panel-2 font-bold text-ink-2"
        style={{ width: size, height: size, fontSize: size * 0.5 }}
        aria-hidden
      >
        {symbol?.[0] ?? "?"}
      </span>
    );
  }

  return (
    <Image
      key={src}
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
