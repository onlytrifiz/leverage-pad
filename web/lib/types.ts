export type Coin = {
  token: string;
  name: string;
  symbol: string;
  pair: string;
  pairSymbol: string;
  pairDecimals: number;
  fee: number;
  pool: string;
  lpTokenId: string;
  subWallet: string;
  creator: string;
  market: string;
  side: "long" | "short";
  leverage: number;
  /** profilo take-profit del motore: scelto al lancio */
  riskProfile?: "safe" | "balanced" | "degen";
  /** supply alla registrazione: riferimento per bruciati = initial − totalSupply */
  initialSupply?: number;
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
  open: boolean;
  collateralUsd: number | null;
  positionSizeUsd: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnlUsd: number | null;
  liquidationPrice: number | null;
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

/** vista di una tranche del motore perp: entry → target con progresso live */
export type TrancheView = {
  /** size in unita' base del mercato (es. "0.00310 BTC") */
  sizeText: string;
  entryMark: number;
  targetMark: number;
  /** avanzamento 0..1 del mark tra entry e target */
  progress: number;
  /** movimento % del sottostante da entry, e % necessaria al target */
  movePct: number;
  neededPct: number;
  collateralUsd: number;
  ts: number;
  synthetic: boolean;
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
  /** ladder delle tranche aperte (ordinate dalla piu' vicina al target) */
  tranches: TrancheView[];
  subWallet: { address: string; quoteBalanceUsd: number | null; coinBalance: number | null };
  /** stato raw del pool per il quote esatto dello swap client-side */
  poolRaw: { sqrtPriceX96: string; liquidity: string; coinIsToken0: boolean } | null;
};
