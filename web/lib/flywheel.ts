import { ethers } from "ethers";
import { loadRegistry } from "./registry";
import { listCoins } from "./detail";
import type { CoinListItem } from "./types";

/** one platform buyback, as the keeper recorded it */
export type Buyback = { at: number; usd: number; tokens: number; buyTx: string; burnTx: string | null };

export type Flywheel = {
  /** the platform token, once it is live; null until then */
  token: CoinListItem | null;
  revenueUsd: number;
  spentUsd: number;
  waitingUsd: number;
  burned: number;
  /** ms, the last time the keeper looked; the next is an interval later */
  lastRunAt: number | null;
  buybacks: Buyback[];
};

const usd = (raw: string) => Number(ethers.utils.formatUnits(raw || "0", 6));
const tokens = (raw: string) => Number(ethers.utils.formatEther(raw || "0"));

/** the platform's buyback & burn from the keeper's snapshot, and every token with its own burn */
export async function loadFlywheel(): Promise<{ flywheel: Flywheel; coins: CoinListItem[] }> {
  const [reg, coins] = await Promise.all([loadRegistry(), listCoins()]);
  const fw = reg.flywheel;
  const token = fw ? (coins.find((c) => c.coin.token.toLowerCase() === fw.token.toLowerCase()) ?? null) : null;
  return {
    coins,
    flywheel: {
      token,
      revenueUsd: fw ? usd(fw.revenueRaw) : 0,
      spentUsd: fw ? usd(fw.spentRaw) : 0,
      waitingUsd: fw ? usd(fw.owedRaw) : 0,
      burned: fw ? tokens(fw.burnedRaw) : 0,
      lastRunAt: fw?.lastRunAt || null,
      buybacks: (fw?.history ?? []).map((h) => ({ ...h, tokens: Number(h.tokens) })),
    },
  };
}
