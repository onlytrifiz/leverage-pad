import { ethers } from "ethers";
import { loadRegistry, type RegistryTranche } from "./registry";
import { erc20, poolState, poolCandles, coinFeed } from "./chain";
import { resolveAccountIndex, perpPosition } from "./lighter";
import { demoCoins, demoDetail, demoCandles, demoFeed, demoPositions } from "./mock";
import { FORCE_DEMO, TREASURY } from "./config";
import type { Candle, Coin, CoinDetail, CoinListItem, FeedItem, OpenPosition, TrancheView } from "./types";

/** trigger dei profili di rischio (speculare a config.js del keeper) */
export const RISK_TRIGGERS: Record<string, number> = { safe: 0.2, balanced: 0.5, degen: 1.0 };

/** costruisce la vista ladder delle tranche dal registry + mark live */
export function buildTrancheViews(
  raw: RegistryTranche[] | undefined,
  coin: Pick<Coin, "side" | "leverage" | "market" | "riskProfile">,
  mark: number | null
): TrancheView[] {
  if (!raw?.length) return [];
  const trigger = RISK_TRIGGERS[coin.riskProfile ?? "balanced"] ?? 0.5;
  const move = trigger / coin.leverage;
  return raw
    .map((t) => {
      const target = coin.side === "short" ? t.entryMark * (1 - move) : t.entryMark * (1 + move);
      const m = mark ?? t.entryMark;
      const span = target - t.entryMark;
      const progress = span !== 0 ? Math.max(0, Math.min(1, (m - t.entryMark) / span)) : 0;
      const movePct = ((coin.side === "short" ? t.entryMark - m : m - t.entryMark) / t.entryMark) * 100;
      return {
        sizeText: `${(t.base / 10 ** t.sizeDec).toFixed(Math.min(t.sizeDec, 6))} ${coin.market}`,
        entryMark: t.entryMark,
        targetMark: target,
        progress,
        movePct,
        neededPct: move * 100,
        collateralUsd: t.collateralUsd,
        ts: t.ts,
        synthetic: !!t.synthetic,
      };
    })
    .sort((a, b) => b.progress - a.progress);
}

/**
 * Assemblaggio dei dati per pagina: registry (bucket) + chain (prezzo, supply,
 * saldi) + Lighter (posizione perp). Demo mode a registry vuoto.
 */

const fmt = (raw: string, dec: number) => Number(ethers.utils.formatUnits(raw || "0", dec));

export function isDemo(): boolean {
  return FORCE_DEMO || loadRegistry().coins.length === 0;
}

export async function listCoins(): Promise<CoinListItem[]> {
  if (isDemo()) {
    return demoCoins().map((coin) => {
      const d = demoDetail(coin.token)!;
      return {
        coin,
        priceUsd: d.stats.priceUsd,
        marketCapUsd: d.stats.marketCapUsd,
        burnedTokens: d.stats.burnedTokens,
        feesCollectedUsd: d.stats.feesCollectedUsd,
        perpOpen: !!d.perp?.open,
        demo: true,
      };
    });
  }
  const reg = loadRegistry();
  return Promise.all(
    reg.coins.map(async (coin) => {
      const st = reg.state[coin.token.toLowerCase()];
      let priceUsd: number | null = null;
      let marketCapUsd: number | null = null;
      let totalSupply: number | null = null;
      try {
        const [ps, supply] = await Promise.all([poolState(coin), erc20(coin.token).totalSupply()]);
        priceUsd = ps.priceUsd;
        totalSupply = Number(ethers.utils.formatUnits(supply, 18));
        marketCapUsd = ps.priceUsd * totalSupply;
      } catch (e) {
        // RPC giu' o pool illeggibile: la lista mostra i trattini, ma il motivo va nei log
        console.error(`[listCoins] ${coin.symbol}: ${(e as Error).message?.slice(0, 160)}`);
      }
      return {
        coin,
        priceUsd,
        marketCapUsd,
        // stessa fonte del dettaglio: cattura anche i burn del locker e degli utenti
        burnedTokens:
          coin.initialSupply != null && totalSupply != null
            ? Math.max(0, coin.initialSupply - totalSupply)
            : st ? fmt(st.totalBurnedRaw, 18) : 0,
        feesCollectedUsd: st ? fmt(st.totalCollected0, coin.pairDecimals) : 0,
        perpOpen: !!st?.perpOpen,
        demo: false,
      };
    })
  );
}

export async function coinDetail(address: string): Promise<CoinDetail | null> {
  if (isDemo()) return demoDetail(address);
  const reg = loadRegistry();
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return null;
  const st = reg.state[coin.token.toLowerCase()];

  const [ps, supplyRaw, quoteBal, coinBal] = await Promise.all([
    poolState(coin).catch(() => null),
    erc20(coin.token).totalSupply().catch(() => null),
    erc20(coin.pair).balanceOf(coin.subWallet).catch(() => null),
    erc20(coin.token).balanceOf(coin.subWallet).catch(() => null),
  ]);

  const totalSupply = supplyRaw ? Number(ethers.utils.formatUnits(supplyRaw, 18)) : null;
  // bruciati = supply iniziale − supply corrente: cattura TUTTI i burn (quelli del
  // locker a ogni collect, i buyback del keeper, gli invii a 0xdEaD degli utenti).
  // Fallback sul contatore del keeper per coin registrate senza initialSupply.
  const burnedTokens =
    coin.initialSupply != null && totalSupply != null
      ? Math.max(0, coin.initialSupply - totalSupply)
      : st ? fmt(st.totalBurnedRaw, 18) : 0;
  const priceUsd = ps?.priceUsd ?? null;

  let perp = null;
  const accountIndex =
    st?.lighterAccountIndex ?? (await resolveAccountIndex(coin.subWallet).catch(() => null));
  if (accountIndex != null) {
    perp = await perpPosition(accountIndex, coin.market).catch(() => null);
  }
  const tranches = buildTrancheViews(st?.perpTranches, coin, perp?.markPrice ?? null);

  const d = coin.pairDecimals;
  return {
    demo: false,
    coin,
    stats: {
      priceUsd,
      marketCapUsd: priceUsd != null && totalSupply != null ? priceUsd * totalSupply : null,
      totalSupply,
      burnedTokens,
      burnedPct: totalSupply != null ? burnedTokens / (totalSupply + burnedTokens) : null,
      feesCollectedUsd: st ? fmt(st.totalCollected0, d) : 0,
      buybackReserveUsd: st ? fmt(st.buybackReserveRaw, d) : 0,
      perpReserveUsd: st ? fmt(st.perpReserveRaw, d) : 0,
      creatorOwedUsd: st ? fmt(st.creatorOwedRaw, d) : 0,
      treasuryOwedUsd: st ? fmt(st.treasuryOwedRaw, d) : 0,
      perpFundedUsd: st?.perpDepositedUsd ?? 0,
      updatedAt: Math.floor(Date.now() / 1000),
    },
    perp,
    tranches,
    subWallet: {
      address: coin.subWallet,
      quoteBalanceUsd: quoteBal ? Number(ethers.utils.formatUnits(quoteBal, d)) : null,
      coinBalance: coinBal ? Number(ethers.utils.formatUnits(coinBal, 18)) : null,
    },
    poolRaw: ps
      ? { sqrtPriceX96: ps.sqrtPriceX96.toString(), liquidity: ps.liquidity.toString(), coinIsToken0: ps.coinIsToken0 }
      : null,
  };
}

export async function coinCandles(address: string): Promise<Candle[]> {
  if (isDemo()) return demoCandles(address);
  const reg = loadRegistry();
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return [];
  return poolCandles(coin).catch(() => []);
}

export async function coinFeedItems(address: string): Promise<FeedItem[]> {
  if (isDemo()) return demoFeed(address);
  const reg = loadRegistry();
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return [];
  return coinFeed(coin, coin.creator, TREASURY).catch(() => []);
}

/** posizioni perp aperte su tutte le coin (per la sidebar della home) */
export async function openPositions(): Promise<OpenPosition[]> {
  if (isDemo()) return demoPositions();
  const reg = loadRegistry();
  const rows = await Promise.all(
    reg.coins.map(async (coin): Promise<OpenPosition | null> => {
      const st = reg.state[coin.token.toLowerCase()];
      const accountIndex =
        st?.lighterAccountIndex ?? (await resolveAccountIndex(coin.subWallet).catch(() => null));
      if (accountIndex == null) return null;
      const p = await perpPosition(accountIndex, coin.market).catch(() => null);
      if (!p?.open) return null;
      const pnlPct =
        p.unrealizedPnlUsd != null && p.collateralUsd ? (p.unrealizedPnlUsd / p.collateralUsd) * 100 : null;
      return {
        token: coin.token,
        symbol: coin.symbol,
        market: coin.market,
        side: coin.side,
        leverage: coin.leverage,
        notionalUsd: p.positionSizeUsd,
        collateralUsd: p.collateralUsd,
        pnlUsd: p.unrealizedPnlUsd,
        pnlPct,
        ageDays: Math.floor((Date.now() - new Date(coin.createdAt).getTime()) / 86_400_000),
        demo: false,
      };
    })
  );
  return rows.filter((r): r is OpenPosition => r != null);
}
