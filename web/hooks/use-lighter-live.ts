"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  getMarketStats,
  getAccountPositions,
  subscribeAccountPositions,
  subscribeMarketStat,
  subscribeMarketStats,
  type LivePosition,
  type MarketStat,
} from "@/lib/lighterStream";

/**
 * Letture dallo stream di Lighter.
 *
 * Passano tutte da `useSyncExternalStore`: il socket e' uno stato che vive
 * fuori da React, e questo e' il solo modo di leggerlo senza rimettere ogni
 * messaggio dentro un `useState` in un effetto.
 *
 * Tutte tornano il valore "non so ancora" (`{}` o `null`) finche' lo stream non
 * ha parlato, cosi' chi le usa puo' restare sul dato renderizzato dal server:
 * la pagina deve essere corretta anche dove il websocket non si apre.
 */

const NO_STATS: Record<number, MarketStat> = {};
const NOOP_UNSUB = () => {};

/**
 * Mark, variazione e volume di OGNI mercato in push.
 *
 * Da usare con cognizione: il canale costa 1.5MB al minuto (misurato), piu' del
 * polling REST che serve la stessa lista. Per una pagina che guarda un mercato
 * solo c'e' `useMarketStat`.
 */
export function useMarketStats(): Record<number, MarketStat> {
  return useSyncExternalStore(subscribeMarketStats, getMarketStats, () => NO_STATS);
}

/** un mercato solo, in push: 0.3KB/s invece di 25 */
export function useMarketStat(marketId: number | null | undefined): MarketStat | null {
  const subscribe = useCallback(
    (onChange: () => void) =>
      marketId == null ? NOOP_UNSUB : subscribeMarketStat(marketId, onChange),
    [marketId]
  );
  const snapshot = useCallback(
    () => (marketId == null ? null : (getMarketStats()[marketId] ?? null)),
    [marketId]
  );
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** tutte le posizioni aperte di un conto, dal vivo */
export function useLivePositions(
  accountIndex: number | null | undefined
): Record<number, LivePosition> | null {
  const subscribe = useCallback(
    (onChange: () => void) =>
      accountIndex == null ? NOOP_UNSUB : subscribeAccountPositions(accountIndex, onChange),
    [accountIndex]
  );
  const snapshot = useCallback(
    () => (accountIndex == null ? null : getAccountPositions(accountIndex)),
    [accountIndex]
  );
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * La posizione di un conto su un mercato, dal vivo.
 *
 * `null` sia quando lo stream non ha ancora parlato sia quando la posizione non
 * c'e': per distinguere i due casi — "non so" e "chiusa" — si guarda la mappa
 * intera con `useLivePositions`, che e' `null` solo nel primo.
 */
export function useLivePosition(
  accountIndex: number | null | undefined,
  marketId: number | null | undefined
): LivePosition | null {
  const all = useLivePositions(accountIndex);
  return marketId == null ? null : (all?.[marketId] ?? null);
}

/**
 * Il mark di un mercato, dal vivo.
 *
 * Viene dal canale del MERCATO, non da quello del conto: il canale del conto
 * parla solo quando la posizione cambia (fill, funding), quindi un mark dedotto
 * da li' — entry ± pnl/size — resterebbe fermo per ore su una posizione che non
 * si muove, mentre il prezzo corre.
 */
export function useLiveMark(marketId: number | null | undefined): number | null {
  return useMarketStat(marketId)?.mark ?? null;
}
