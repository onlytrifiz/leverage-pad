"use client";

import { useEffect, useRef, useState } from "react";
import { fmtInt, fmtPct } from "@/lib/format";

/**
 * Il segno-firma della pagina: le coin bruciate come odometro che sale,
 * con la barra della supply consumata. Il burn e' la promessa del prodotto —
 * tutto il resto della pagina resta quieto, questo numero arde.
 */
export default function BurnOdometer({
  burned,
  burnedPct,
}: {
  burned: number;
  burnedPct: number | null;
}) {
  const [shown, setShown] = useState(0);
  const raf = useRef<number>(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || burned === 0) {
      setShown(burned);
      return;
    }
    const start = performance.now();
    const dur = 1400;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const ease = 1 - Math.pow(1 - k, 3);
      setShown(burned * ease);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [burned]);

  return (
    <div>
      <div className="lbl mb-1.5">tokens burned</div>
      <div className="num text-[26px] font-semibold leading-none text-accent-bright green-glow">
        {fmtInt(shown)}
      </div>
      {burnedPct != null && (
        <div className="mt-2.5">
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-panel-2">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.min(100, burnedPct * 100)}%` }}
            />
          </div>
          <div className="lbl mt-1.5">{fmtPct(burnedPct)} of supply destroyed</div>
        </div>
      )}
    </div>
  );
}
