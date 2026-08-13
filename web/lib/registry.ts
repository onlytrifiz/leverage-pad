import fs from "fs";
import { REGISTRY_PATH } from "./config";
import type { Coin } from "./types";

/**
 * Lettura del registry del keeper (state/registry.json della repo madre).
 * reg.coins = anagrafica; reg.state[token] = contabilita' bucket per coin.
 * Il file e' scritto atomicamente dal keeper: leggerlo a ogni richiesta e' sicuro.
 */

export type RegistryTranche = {
  base: number;
  entryMark: number;
  collateralUsd: number;
  sizeDec: number;
  ts: number;
  synthetic?: boolean;
};

export type CoinState = {
  perpReserveRaw: string;
  buybackReserveRaw: string;
  treasuryOwedRaw: string;
  creatorOwedRaw: string;
  totalCollected0: string;
  totalBurnedRaw: string;
  perpOpen: boolean;
  perpDepositedUsd: number;
  perpRealizedUsd: number;
  perpWithdrawPendingUsd: number;
  perpTranches?: RegistryTranche[];
  lighterAccountIndex: number | null;
  lastTickTs: number;
};

export type Registry = { coins: Coin[]; state: Record<string, CoinState> };

export function loadRegistry(): Registry {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return { coins: [], state: {} };
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return { coins: [], state: {} };
  }
}
