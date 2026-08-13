"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** rinfresca i dati server della pagina a intervallo fisso (stats, perp, saldi) */
export default function AutoRefresh({ everyMs = 20_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
