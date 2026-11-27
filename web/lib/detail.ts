import { ethers } from "ethers";
import { loadRegistry, type CoinState, type RegistryTranche } from "./registry";
import { coinFeed, readCoinStates, loadRouterCoins, poolFeesUsd, readManagedDelay } from "./chain";
import { resolveAccountIndex, perpPosition, perpFromView, marketRow } from "./lighter";
import { demoCoins, demoDetail, demoCandles, demoFeed, demoPositions } from "./mock";
import { FORCE_DEMO } from "./config";
import { PROFIT_SPLIT_PCT, decayedTakeProfitPct } from "./doppler";
import { chartData } from "./trades";
import type { ChartData, Coin, CoinDetail, CoinListItem, FeedItem, OpenPosition, Resolution, TrancheView } from "./types";

/**
 * The tranche ladder from the keeper's book and the live mark. Each tranche runs to its own
 * target: entry × (1 ± take-profit / leverage), with the leverage it was opened at and the
 * take-profit after the decay of its age (the keeper's rule, mirrored by decayedTakeProfitPct).
 */
export function buildTrancheViews(
  raw: RegistryTranche[] | undefined,
  coin: Pick<Coin, "side" | "leverage" | "market" | "takeProfitPct">,
  mark: number | null,
  nowMs = Date.now()
): TrancheView[] {
  if (!raw?.length) return [];
  return raw
    .map((t) => {
      const leverage = t.leverage ?? coin.leverage;
      const takeProfitPct = decayedTakeProfitPct(coin.takeProfitPct, (nowMs - t.ts) / 86_400_000);
      const move = takeProfitPct / 100 / leverage;
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
        takeProfitPct,
        leverage,
      };
    })
    .sort((a, b) => b.progress - a.progress);
}

/**
 * Assemblaggio dei dati per pagina: registry (bucket) + chain (prezzo, supply,
 * saldi) + Lighter (posizione perp). Demo mode a registry vuoto.
 */

/** what a take-profit took out and has not reached the wallet yet, less the protocol's share of its gain */
function buybackWaiting(st: CoinState) {
  const gain = st.perpRealizedUsd ?? 0;
  const out = Math.max(0, gain + (st.perpCapitalUsd ?? 0)) + (st.perpWithdrawPendingUsd ?? 0);
  const onGain = Math.max(0, gain) + (st.perpWithdrawPendingProfitUsd ?? st.perpWithdrawPendingUsd ?? 0);
  return Math.max(0, out - (onGain * PROFIT_SPLIT_PCT.treasury) / 100);
}

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
  const [states, feesFromSwaps, managedDelayS] = await Promise.all([
    readCoinStates([coin], { withSubWallet: true }),
    poolFeesUsd(coin).catch(() => 0),
    readManagedDelay(),
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

  // while a managed coin switches, what is open (and its tranches) belongs to the engine before
  const switching = st?.perpSwitch ?? null;
  const book = { ...coin, ...(switching?.from ?? {}) };
  let perp = null;
  // a token the keeper knows has no account until it says so: Lighter is asked only about others
  const accountIndex = st
    ? (st.lighterAccountIndex ?? null)
    : await resolveAccountIndex(coin.subWallet).catch(() => null);
  if (accountIndex != null) {
    // the keeper's read when there is one; Lighter itself only for a token it has not read yet
    perp = st?.perpView
      ? perpFromView(accountIndex, st.perpView, await marketRow(book.market).catch(() => null))
      : await perpPosition(accountIndex, book.market).catch(() => null);
  }
  const tranches = buildTrancheViews(st?.perpTranches, book, perp?.markPrice ?? null);

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
      waitingUsd: (chain.subQuote ?? 0) * chain.subEngineShare + (st ? fmt(st.perpReserveRaw, d) : 0),
      idleUsd: perp && !perp.open ? Math.max(0, (perp.freeUsd ?? 0) - Math.max(0, (st?.perpRealizedUsd ?? 0) + (st?.perpCapitalUsd ?? 0))) : 0,
      buybackWaitingUsd: st ? buybackWaiting(st) + fmt(st.buybackReserveRaw, d) : 0,
      creatorOwedUsd: st ? fmt(st.creatorOwedRaw, d) : 0,
      treasuryOwedUsd: st ? fmt(st.treasuryOwedRaw, d) : 0,
      perpFundedUsd: st?.perpDepositedUsd ?? 0,
      updatedAt: Math.floor(Date.now() / 1000),
    },
    perp,
    tranches,
    closed: [...(st?.perpClosed ?? [])].sort((a, b) => b.closedAt - a.closedAt),
    engineBlocked: st?.engineBlocked ?? null,
    engineSwitch: switching ? { from: switching.from } : null,
    managedDelayS,
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

/** the keeper's wallet for a coin: what it buys is a buyback. The fee sink is another address. */
async function engineWallet(token: string): Promise<string | undefined> {
  const { coins } = await loadRegistry();
  return coins.find((c) => c.token.toLowerCase() === token.toLowerCase())?.subWallet;
}

/** everything the chart draws; null for an unknown coin, throws when the pool cannot be read */
export async function coinChart(address: string, resolution: Resolution): Promise<ChartData | null> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) {
    const candles = demoCandles(address);
    if (!candles.length) return null;
    return {
      candles,
      complete: true,
      ath: Math.max(...candles.map((c) => c.high)),
      launchPrice: candles[0].open,
      marks: [],
      lines: [{ ts: candles[0].time, label: "Launch" }],
    };
  }
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return null;
  return chartData(coin, resolution, await engineWallet(coin.token));
}

export async function coinFeedItems(address: string): Promise<FeedItem[]> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) return demoFeed(address);
  const coin = reg.coins.find((c) => c.token.toLowerCase() === address.toLowerCase());
  if (!coin) return [];
  return coinFeed(coin, await engineWallet(coin.token)).catch(() => []);
}

/** posizioni perp aperte su tutte le coin (per la sidebar della home) */
export async function openPositions(): Promise<OpenPosition[]> {
  const reg = await loadAll();
  if (demoFrom(reg.coins)) return demoPositions();
  const rows = await Promise.all(
    reg.coins.map(async (coin): Promise<OpenPosition | null> => {
      const st = reg.state[coin.token.toLowerCase()];
      const accountIndex = st
        ? (st.lighterAccountIndex ?? null)
        : await resolveAccountIndex(coin.subWallet).catch(() => null);
      if (accountIndex == null) return null;
      const { market, side } = st?.perpSwitch?.from ?? coin;
      const p = st?.perpView
        ? perpFromView(accountIndex, st.perpView, await marketRow(market).catch(() => null))
        : await perpPosition(accountIndex, market).catch(() => null);
      if (!p?.open) return null;
      const pnlPct =
        p.unrealizedPnlUsd != null && p.collateralUsd ? (p.unrealizedPnlUsd / p.collateralUsd) * 100 : null;
      return {
        token: coin.token,
        symbol: coin.symbol,
        market,
        accountIndex,
        marketId: p.marketId,
        side,
        // what the venue has, which a change of engine moves later than the coin's own
        leverage: st?.lighterLeverage ?? coin.leverage,
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
