import type { Candle, Coin, CoinDetail, FeedItem, OpenPosition, TrancheView } from "./types";
import { USDG } from "./config";

/**
 * Dati demo: si attivano a registry vuoto (o PERPSPAD_WEB_DEMO=1) cosi' la UI
 * e' visitabile prima del primo lancio di produzione. OGNI superficie demo e'
 * marcata `demo: true` e la UI la etichetta "DEMO DATA" — mai numeri finti
 * spacciati per veri. Generazione deterministica: niente flicker tra render.
 */

// indirizzi demo dalla forma valida ma riconoscibilmente finti (prefisso de30)
const demoAddr = (tail: string) => "0x" + "de30" + "0".repeat(36 - tail.length) + tail;

type DemoSpec = {
  tail: string;
  symbol: string;
  name: string;
  market: string;
  side: "long" | "short";
  leverage: number;
  risk: "safe" | "balanced" | "degen";
  seed: number;
  basePrice: number; // prezzo di partenza della random walk
  burned: number;
  fees: number;
  perpFunded: number;
  perp: CoinDetail["perp"];
  ageDays: number;
};

const SPECS: DemoSpec[] = [
  {
    tail: "4663", symbol: "LNVDA", name: "Leverage NVDA", market: "NVDA", side: "long", leverage: 3, risk: "balanced",
    seed: 4663, basePrice: 0.000072, burned: 12_384_622, fees: 1_284.4, perpFunded: 486.2,
    perp: { open: true, collateralUsd: 512.4, positionSizeUsd: 1_537.2, entryPrice: 187.2, markPrice: 191.85, unrealizedPnlUsd: 38.16, liquidationPrice: 129.4 },
    ageDays: 3,
  },
  {
    tail: "0a17", symbol: "ANTHRO", name: "Anthropic Before The Bell", market: "ANTHROPIC", side: "long", leverage: 5, risk: "degen",
    seed: 2027, basePrice: 0.000114, burned: 31_002_450, fees: 3_912.7, perpFunded: 1_542.9,
    perp: { open: true, collateralUsd: 1_618.3, positionSizeUsd: 8_091.5, entryPrice: 61.4, markPrice: 66.85, unrealizedPnlUsd: 718.4, liquidationPrice: 50.9 },
    ageDays: 9,
  },
  {
    tail: "b7c0", symbol: "LBTC", name: "Long Bitcoin Forever", market: "BTC", side: "long", leverage: 2, risk: "safe",
    seed: 21_000, basePrice: 0.000041, burned: 4_512_090, fees: 640.1, perpFunded: 212.0,
    perp: { open: true, collateralUsd: 224.6, positionSizeUsd: 449.2, entryPrice: 61_240, markPrice: 63_690, unrealizedPnlUsd: 17.9, liquidationPrice: 33_100 },
    ageDays: 6,
  },
  {
    tail: "5e11", symbol: "STSLA", name: "Tesla Bears Club", market: "TSLA", side: "short", leverage: 3, risk: "balanced",
    seed: 777, basePrice: 0.000019, burned: 902_114, fees: 148.6, perpFunded: 42.5,
    perp: { open: true, collateralUsd: 44.1, positionSizeUsd: 132.3, entryPrice: 412.6, markPrice: 405.1, unrealizedPnlUsd: 2.4, liquidationPrice: 549.0 },
    ageDays: 2,
  },
  {
    tail: "91ad", symbol: "LPLTR", name: "Palantir Maximalist", market: "PLTR", side: "long", leverage: 10, risk: "degen",
    seed: 3141, basePrice: 0.0000082, burned: 0, fees: 36.2, perpFunded: 0,
    perp: null, // riserva sotto il gate: motore in accumulo
    ageDays: 0,
  },
];

const specCoin = (s: DemoSpec): Coin => ({
  token: demoAddr(s.tail),
  name: s.name,
  symbol: s.symbol,
  pair: USDG,
  pairSymbol: "USDG",
  pairDecimals: 6,
  fee: 10000,
  pool: demoAddr(s.tail.split("").reverse().join("") + "1"),
  lpTokenId: String(1 + SPECS.indexOf(s)),
  subWallet: demoAddr(s.tail + "2"),
  creator: demoAddr(s.tail + "3"),
  market: s.market,
  side: s.side,
  leverage: s.leverage,
  riskProfile: s.risk,
  createdAt: new Date(Date.now() - s.ageDays * 86_400_000).toISOString(),
});

export const demoCoins = (): Coin[] => SPECS.map(specCoin);

const findSpec = (address: string) =>
  SPECS.find((s) => demoAddr(s.tail).toLowerCase() === address.toLowerCase());

// PRNG deterministico (mulberry32): stessa demo a ogni render
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_NOW = Math.floor(Date.now() / 1000 / 900) * 900; // ancorato al quarto d'ora

function specCandles(s: DemoSpec): Candle[] {
  const r = rng(s.seed);
  const out: Candle[] = [];
  const n = 4 * 24 * 3; // 3 giorni di candele 15m
  let p = s.basePrice;
  for (let i = 0; i < n; i++) {
    const drift = 1 + (r() - 0.47) * 0.05;
    const open = p;
    const close = p * drift;
    const high = Math.max(open, close) * (1 + r() * 0.02);
    const low = Math.min(open, close) * (1 - r() * 0.02);
    out.push({ time: DEMO_NOW - (n - i) * 900, open, high, low, close });
    p = close;
  }
  return out;
}

export function demoCandles(address: string): Candle[] {
  const s = findSpec(address);
  return s ? specCandles(s) : [];
}

export function demoFeed(address: string): FeedItem[] {
  const s = findSpec(address);
  if (!s) return [];
  const r = rng(s.seed + 1337);
  const items: FeedItem[] = [];
  let t = DEMO_NOW;
  const lastPrice = specCandles(s)[4 * 24 * 3 - 1].close;
  const price = () => (lastPrice * (0.97 + r() * 0.06)).toPrecision(4);
  for (let i = 0; i < 22; i++) {
    t -= Math.floor(60 + r() * 480);
    const roll = r();
    if (roll < 0.45) {
      const buying = r() > 0.42;
      items.push({ kind: "tick", text: `trade @ ${price()}`, amountText: `${buying ? "+" : "−"}$${(5 + r() * 180).toFixed(2)}`, tone: buying ? "up" : "down", ts: t, txHash: "0xdemo" });
    } else if (roll < 0.62) {
      items.push({ kind: "collect", text: "fees collected", amountText: `$${(1 + r() * 9).toFixed(2)}`, tone: "plain", ts: t, txHash: "0xdemo" });
    } else if (roll < 0.78) {
      items.push({ kind: "burn", text: "burned", amountText: `${Math.floor(20000 + r() * 300000).toLocaleString("en-US")} ${s.symbol}`, tone: "accent", ts: t, txHash: "0xdemo" });
    } else if (roll < 0.9) {
      items.push({ kind: "buyback", text: "buyback", amountText: `$${(25).toFixed(2)}`, tone: "accent", ts: t, txHash: "0xdemo" });
    } else if (roll < 0.96) {
      items.push({ kind: "treasury", text: "treasury paid", amountText: `$${(1 + r() * 6).toFixed(2)}`, tone: "plain", ts: t, txHash: "0xdemo" });
    } else {
      items.push({ kind: "deposit", text: "perp deposit → lighter", amountText: `$${(20 + r() * 8).toFixed(2)}`, tone: "accent", ts: t, txHash: "0xdemo" });
    }
  }
  return items;
}

/** ladder demo: 3-4 tranche a entry crescenti sotto il mark corrente */
function demoTranches(s: DemoSpec): TrancheView[] {
  if (!s.perp?.open || s.perp.markPrice == null) return [];
  const r = rng(s.seed + 42);
  const mark = s.perp.markPrice;
  const trigger = s.risk === "safe" ? 0.2 : s.risk === "degen" ? 1.0 : 0.5;
  const move = trigger / s.leverage;
  const n = 3 + Math.floor(r() * 2);
  const out: TrancheView[] = [];
  for (let i = 0; i < n; i++) {
    // entry sparsi tra "quasi maturo" e "appena aperto"
    const doneFrac = 0.15 + r() * 0.75 - i * 0.08;
    const entry = s.side === "short" ? mark / (1 - move * doneFrac) : mark / (1 + move * doneFrac);
    const target = s.side === "short" ? entry * (1 - move) : entry * (1 + move);
    const span = target - entry;
    const progress = Math.max(0, Math.min(1, (mark - entry) / span));
    const movePct = ((s.side === "short" ? entry - mark : mark - entry) / entry) * 100;
    const collateral = 20 + r() * 60;
    out.push({
      sizeText: `${((collateral * s.leverage) / mark).toFixed(4)} ${s.market}`,
      entryMark: entry,
      targetMark: target,
      progress,
      movePct,
      neededPct: move * 100,
      collateralUsd: collateral,
      ts: DEMO_NOW - (i + 1) * 86_400 - Math.floor(r() * 40_000),
      synthetic: false,
    });
  }
  return out.sort((a, b) => b.progress - a.progress);
}

export function demoDetail(address: string): CoinDetail | null {
  const s = findSpec(address);
  if (!s) return null;
  const candles = specCandles(s);
  const price = candles[candles.length - 1].close;
  const supply = 1_000_000_000 - s.burned;
  const r = rng(s.seed + 7);
  return {
    demo: true,
    coin: specCoin(s),
    stats: {
      priceUsd: price,
      marketCapUsd: price * supply,
      totalSupply: supply,
      burnedTokens: s.burned,
      burnedPct: s.burned / 1_000_000_000,
      feesCollectedUsd: s.fees,
      buybackReserveUsd: 3 + r() * 20,
      perpReserveUsd: s.perp ? 5 + r() * 14 : 8 + r() * 10,
      creatorOwedUsd: r(),
      treasuryOwedUsd: r(),
      perpFundedUsd: s.perpFunded,
      updatedAt: DEMO_NOW,
    },
    perp: s.perp,
    tranches: demoTranches(s),
    subWallet: { address: specCoin(s).subWallet, quoteBalanceUsd: 10 + r() * 40, coinBalance: 0 },
    poolRaw: null, // demo: swap disabilitato
  };
}

export function demoPositions(): OpenPosition[] {
  return SPECS.filter((s) => s.perp?.open).map((s) => {
    const p = s.perp!;
    const pnlPct = p.collateralUsd ? (p.unrealizedPnlUsd! / p.collateralUsd) * 100 : 0;
    return {
      token: demoAddr(s.tail),
      symbol: s.symbol,
      market: s.market,
      side: s.side,
      leverage: s.leverage,
      notionalUsd: p.positionSizeUsd,
      collateralUsd: p.collateralUsd,
      pnlUsd: p.unrealizedPnlUsd,
      pnlPct,
      ageDays: s.ageDays,
      demo: true,
    };
  });
}
