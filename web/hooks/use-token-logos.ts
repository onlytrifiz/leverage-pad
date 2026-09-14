"use client";

import { useSyncExternalStore } from "react";
import type { TokenLogo } from "@/lib/lighter";

/**
 * Anagrafica dei logo Lighter, una volta per sessione del browser.
 *
 * Sta in un modulo e non in un context perche' le icone compaiono ovunque —
 * ticker, rail, card del perp, pagina del token — e non tutte quelle pagine
 * montano lo stesso provider. Una fetch sola, condivisa da ogni istanza, e i
 * componenti che si iscrivono al risultato.
 *
 * Fallire qui non e' un errore visibile: senza mappa l'icona ricade sul nome
 * convenzionale (`<simbolo>.png`), che e' la forma di ogni logo su Robinhood
 * Chain oggi. La mappa serve per i nomi che NON seguono la convenzione (0G sta
 * su `zeroG.png`) e per i pochi token con lo svg.
 */

const EMPTY: Record<string, TokenLogo> = {};

let cache: Record<string, TokenLogo> | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load() {
  if (cache || inflight) return;
  inflight = fetch("/api/tokens")
    .then((r) => r.json())
    .then((j: { logos?: Record<string, TokenLogo> }) => j.logos ?? EMPTY)
    .catch(() => EMPTY)
    .then((m) => {
      cache = m;
      inflight = null;
      for (const fn of listeners) fn();
    });
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  load();
  return () => {
    listeners.delete(onChange);
  };
}

// il riferimento resta lo stesso finche' la mappa non cambia: e' il contratto
// che useSyncExternalStore pretende per non rerenderizzare a ogni frame
const getSnapshot = () => cache ?? EMPTY;
const getServerSnapshot = () => EMPTY;

export function useTokenLogos(): Record<string, TokenLogo> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
