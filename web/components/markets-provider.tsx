"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { MarketRow } from "@/lib/lighter";

/**
 * One owner for the Lighter market list, for the whole page.
 *
 * The ticker, the markets rail and the launch form each used to run their own
 * interval against the same endpoint — three timers, three copies of the same
 * list, and three chances for them to disagree about the price of NVDA on the
 * same screen. Now the data has one owner and the components just read it.
 *
 * This one polls, deliberately. Lighter streams the whole market table over
 * `market_stats/all`, and for a list of 57 rows that is the wrong trade: the
 * channel was measured at 508KB per 20 seconds — 1.5MB a minute against the
 * ~25KB one REST response costs. Streaming wins when a page follows ONE market
 * (see `useMarketStat`, 0.3KB/s) or one account. A ticker is not that page.
 */

type MarketsCtx = {
  markets: MarketRow[];
  /** null until the first response lands, so lists can show a real skeleton */
  loaded: boolean;
};

const Ctx = createContext<MarketsCtx>({ markets: [], loaded: false });

export const useMarkets = () => useContext(Ctx);

export function MarketsProvider({
  children,
  everyMs = 20_000,
}: {
  children: React.ReactNode;
  everyMs?: number;
}) {
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/markets");
        const j = (await r.json()) as { markets?: MarketRow[] };
        if (alive) setMarkets(j.markets ?? []);
      } catch {
        /* keep the last good list rather than blanking the screen */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    load();
    const id = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [everyMs]);

  const value = useMemo(() => ({ markets, loaded }), [markets, loaded]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
