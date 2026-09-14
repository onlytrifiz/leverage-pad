"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "@/components/animate-ui/icons/refresh-cw";

/**
 * Refreshes the page's server data on a fixed interval (stats, perp, balances).
 *
 * It used to do that silently, which on a page of live figures is the wrong
 * kind of quiet: numbers changed with nothing to say they had been re-read.
 * The indicator now spins in place, inline, wherever the page puts it — as a
 * floating pill it landed on top of the rail's launch button.
 */
export default function AutoRefresh({
  everyMs = 20_000,
  label = "Live",
}: {
  everyMs?: number;
  label?: string;
}) {
  const router = useRouter();
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    let stop: ReturnType<typeof setTimeout>;
    const id = setInterval(() => {
      setSpinning(true);
      router.refresh();
      stop = setTimeout(() => setSpinning(false), 900);
    }, everyMs);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [router, everyMs]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
      <RefreshCw aria-hidden size={11} animate={spinning} />
      {label}
    </span>
  );
}
