export type EngineSettings = { market: string; side: "long" | "short"; leverage: number; takeProfitPct: number };

/** one line of a coin's engine history, from the router's events */
export type EngineLogItem = {
  kind: "announced" | "withdrawn" | "override";
  /** what was announced or set; an override only sets leverage and take-profit, a withdrawal nothing */
  engine: Partial<EngineSettings> | null;
  ts: number;
  txHash: string;
  effectiveAt?: number;
};

/**
 * A coin launched through the multiply router: a Doppler market on Uniswap v4.
 * Everything here is read from the router's `MultiplyLaunch` event and the
 * token's IPFS metadata; nothing needs the keeper to exist.
 */
export type Coin = {
  token: string;
  name: string;
  symbol: string;
  /** Uniswap v4 pool id (keccak of the PoolKey); also the DexScreener pair id */
  poolId: string;
  /** the numeraire: USDG on every launch today */
  pair: string;
  pairSymbol: string;
  pairDecimals: number;
  /** trading fee taken by the hook, 1e6-based (30_000 = 3%) */
  fee: number;
  antiSnipe: boolean;
  /** opening market cap in numeraire units, as launched */
  openingMcapUsd: number;
  /** wallet that sent the launch */
  launcher: string;
  /** where the fees land until the keeper adopts the coin (hub), then the coin's sub-wallet */
  subWallet: string;
  creator: string;
  market: string;
  side: "long" | "short";
  leverage: number;
  /** each deposit banks at +takeProfitPct% on its collateral (current value, after any change) */
  takeProfitPct: number;
  /** launched managed: its creator may change the engine (market and side too), after a notice */
  managed: boolean;
  /** a managed coin's announced change, not in effect yet */
  pendingEngine: (EngineSettings & { effectiveAt: number }) | null;
  /** every change announced, withdrawn or overridden since launch, newest first */
  engineLog: EngineLogItem[];
  tokenURI: string;
  /** the metadata's image as a loadable URL (the creator's logo, or the generated seal) */
  image?: string;
  /** links from the metadata, https only */
  socials?: { website?: string; x?: string; telegram?: string };
  /** supply at launch: burned = initial − totalSupply */
  initialSupply?: number;
  launchBlock: number;
  createdAt: string;
};

export type CoinListItem = {
  coin: Coin;
  priceUsd: number | null;
  marketCapUsd: number | null;
  burnedTokens: number;
  feesCollectedUsd: number;
  perpOpen: boolean;
  demo: boolean;
};

export type OpenPosition = {
  token: string;
  symbol: string;
  market: string;
  /** conto e mercato su Lighter: la riga si aggiorna da sola dallo stream */
  accountIndex: number | null;
  marketId: number | null;
  side: "long" | "short";
  leverage: number;
  notionalUsd: number | null;
  collateralUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  ageDays: number;
  demo: boolean;
};

export type PerpPosition = {
  /** identita' della posizione sul venue: serve al canale websocket che la segue
   *  live. Null in demo, dove non c'e' nessun conto da seguire. */
  accountIndex: number | null;
  marketId: number | null;
  open: boolean;
  collateralUsd: number | null;
  positionSizeUsd: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnlUsd: number | null;
  liquidationPrice: number | null;
  /** funding cumulativo pagato (negativo) o incassato dalla posizione */
  fundingPaidUsd: number | null;
};

export type FeedItem = {
  kind: "collect" | "burn" | "buyback" | "creator" | "treasury" | "deposit" | "tick";
  text: string;
  amountText?: string;
  /** segno per la colorazione: up | down | accent | plain */
  tone: "up" | "down" | "accent" | "plain";
  txHash?: string;
  ts: number; // unix seconds (stimato dal block number)
};

export type Candle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TrancheView = {
  sizeText: string;
  entryMark: number;
  targetMark: number;
  progress: number;
  movePct: number;
  neededPct: number;
  collateralUsd: number;
  ts: number;
  synthetic: boolean;
  /** this tranche's take-profit now, after the decay of an old deposit's target */
  takeProfitPct: number;
  leverage: number;
};

export type CoinDetail = {
  demo: boolean;
  coin: Coin;
  stats: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    totalSupply: number | null;
    burnedTokens: number;
    burnedPct: number | null;
    feesCollectedUsd: number;
    buybackReserveUsd: number;
    perpReserveUsd: number;
    creatorOwedUsd: number;
    treasuryOwedUsd: number;
    perpFundedUsd: number;
    updatedAt: number;
  };
  perp: PerpPosition | null;
  tranches: TrancheView[];
  /** the keeper's reason for not opening, shown on the coin page; null when the engine can run */
  engineBlocked: string | null;
  /** a managed coin's market or side changed and the keeper is still closing the old position */
  engineSwitch: { from: { market: string; side: "long" | "short" } } | null;
  /** seconds between a managed coin's announcement and its effect, as the router has it now */
  managedDelayS: number;
  subWallet: {
    address: string;
    quoteBalanceUsd: number | null;
    coinBalance: number | null;
  };
  /** live pool state for the swap quote; null in demo or when unreadable */
  poolRaw: { sqrtPriceX96: string; liquidity: string; coinIsToken0: boolean } | null;
};
