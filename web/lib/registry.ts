import fs from "fs";
import { REGISTRY_PATH, REGISTRY_URL } from "./config";
import type { Coin } from "./types";

/**
 * Lettura del registry del keeper: oggi e' solo un OVERLAY (stato perp, tranche)
 * per token address. La lista delle coin viene dagli eventi del router on-chain.
 *
 * Due sorgenti, nello stesso ordine di preferenza:
 *  1. `PERPSPAD_REGISTRY_URL` — lo snapshot PUBBLICO che il keeper pubblica a ogni
 *     tick (`state/public.json`, senza chiavi API ne' stato interno). E' la strada
 *     per il deploy remoto: il sito non condivide il filesystem col keeper.
 *  2. `PERPSPAD_REGISTRY_PATH` — il file locale, per lo sviluppo sulla stessa macchina.
 *
 * Entrambe le forme hanno la stessa struttura: il sito non distingue.
 */

export type RegistryTranche = {
  base: number;
  entryMark: number;
  collateralUsd: number;
  sizeDec: number;
  ts: number;
  synthetic?: boolean;
  /** the leverage set on the venue when the tranche opened (older tranches: the coin's) */
  leverage?: number;
};

export type CoinState = {
  perpReserveRaw: string;
  buybackReserveRaw: string;
  treasuryOwedRaw: string;
  creatorOwedRaw: string;
  totalCollected0: string;
  totalBurnedRaw: string;
  /** (v4) protocol share the coin's sink has already paid to the treasury at flush */
  sinkTreasuryRaw?: string;
  perpOpen: boolean;
  perpDepositedUsd: number;
  perpRealizedUsd: number;
  /** funding cumulativo del perp: negativo = pagato, gia' dentro il realizzato */
  perpFundingUsd?: number;
  perpWithdrawPendingUsd: number;
  perpTranches?: RegistryTranche[];
  lighterAccountIndex: number | null;
  lastTickTs: number;
  /** why the keeper is not opening (e.g. leverage above the venue's cap), null when it can */
  engineBlocked?: string | null;
  /** the leverage actually set on the venue */
  lighterLeverage?: number | null;
};

export type Registry = { coins: Coin[]; state: Record<string, CoinState> };

const EMPTY: Registry = { coins: [], state: {} };

export async function loadRegistry(): Promise<Registry> {
  if (REGISTRY_URL) {
    try {
      // revalidate 5s: il keeper pubblica a ogni tick (~15s), non serve di piu'
      const r = await fetch(REGISTRY_URL, { next: { revalidate: 5 } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Registry;
      return { coins: j.coins ?? [], state: j.state ?? {} };
    } catch (e) {
      console.error(`[registry] snapshot remoto illeggibile (${(e as Error).message}), provo il file locale`);
    }
  }
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return EMPTY;
    const j = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as Registry;
    return { coins: j.coins ?? [], state: j.state ?? {} };
  } catch {
    return EMPTY;
  }
}
