import { ethers } from "ethers";
import { loadRegistry, type RegistryTranche } from "./registry";
import { poolCandles, coinFeed, readCoinStates, loadRouterCoins, poolFeesUsd } from "./chain";
import { resolveAccountIndex, perpPosition } from "./lighter";
import { demoCoins, demoDetail, demoCandles, demoFeed, demoPositions } from "./mock";
import { FORCE_DEMO } from "./config";
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

/** demo se forzata da env o se non c'e' ancora nessuna coin lanciata dal router */
const demoFrom = (coins: unknown[]) => FORCE_DEMO || coins.length === 0;

/** coins from the router's events, keeper state as an overlay keyed by token */
async function loadAll() {
  const [coins, reg] = await Promise.all([loadRouterCoins(), loadRegistry()]);
  return { coins, state: reg.state };
}

export async function isDemo(): Promise<boolean> {
  return demoFrom((await loadAll()).coins);
}

export async function listCoins(): Promise<CoinListItem[]> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) {
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
  /* one Multicall3 round trip for every coin on the page; fees from each pool's swap log */
  const [states, fees] = await Promise.all([
    readCoinStates(reg.coins),
    Promise.all(reg.coins.map((c) => poolFeesUsd(c).catch(() => 0))),
  ]);
  return reg.coins.map((coin, i) => {
    const st = reg.state[coin.token.toLowerCase()];
    const chain = states.get(coin.token.toLowerCase());
    const totalSupply = chain?.totalSupply ?? null;
    return {
      coin,
      priceUsd: chain?.priceUsd ?? null,
      marketCapUsd: chain?.marketCapUsd ?? null,
      burnedTokens:
        coin.initialSupply != null && totalSupply != null ? Math.max(0, coin.initialSupply - totalSupply) : st ? fmt(st.totalBurnedRaw, 18) : 0,
      feesCollectedUsd: st ? fmt(st.totalCollected0, coin.pairDecimals) : fees[i],
      perpOpen: !!st?.perpOpen,
      demo: false,
    };
  });
}

export async function coinDetail(address: string): Promise<CoinDetail | null> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) return demoDetail(address);
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return null;
  const st = reg.state[coin.token.toLowerCase()];

  /* price, supply and both fee-destination balances in a single request; fees from the swap log */
  const [states, feesFromSwaps] = await Promise.all([
    readCoinStates([coin], { withSubWallet: true }),
    poolFeesUsd(coin).catch(() => 0),
  ]);
  const chain = states.get(coin.token.toLowerCase())!;

  const totalSupply = chain.totalSupply;
  // bruciati = supply iniziale − supply corrente: cattura TUTTI i burn (burn() del
  // keeper sui buyback, invii a 0xdEaD degli utenti). Fallback sul contatore del keeper.
  const burnedTokens =
    coin.initialSupply != null && totalSupply != null
      ? Math.max(0, coin.initialSupply - totalSupply)
      : st ? fmt(st.totalBurnedRaw, 18) : 0;
  const priceUsd = chain.priceUsd;

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
      feesCollectedUsd: st ? fmt(st.totalCollected0, d) : feesFromSwaps,
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
      quoteBalanceUsd: chain.subQuote,
      coinBalance: chain.subCoin,
    },
    poolRaw:
      chain.sqrtPriceX96 != null && chain.liquidity != null
        ? {
            sqrtPriceX96: chain.sqrtPriceX96,
            liquidity: chain.liquidity,
            coinIsToken0: chain.coinIsToken0,
          }
        : null,
  };
}

export async function coinCandles(address: string): Promise<Candle[]> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) return demoCandles(address);
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return [];
  return poolCandles(coin).catch(() => []);
}

export async function coinFeedItems(address: string): Promise<FeedItem[]> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) return demoFeed(address);
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return [];
  return coinFeed(coin).catch(() => []);
}

/** posizioni perp aperte su tutte le coin (per la sidebar della home) */
export async function openPositions(): Promise<OpenPosition[]> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) return demoPositions();
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
        accountIndex,
        marketId: p.marketId,
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
