import { ethers } from "ethers";
import { CHAIN_ID, DOPPLER, LAUNCH_ROUTER, UNIVERSAL_ROUTER, V4_POOL_MANAGER } from "./clientConfig";
import { coinPriceFromSqrtP, provider } from "./chain";
import type { Candle, ChartData, ChartMark, Coin, Resolution } from "./types";
import { RESOLUTIONS } from "./resolutions";

/**
 * Every trade of a coin, from its pool's swaps and its token's transfers, kept in memory and
 * extended by the blocks nobody has read yet.
 *
 * History comes from Etherscan V2 when there is a key: the whole life of a pool in one request per
 * thousand swaps, with exact timestamps. The public RPC takes 400k blocks per query, eleven hours of
 * this chain, so without a key history is walked window by window. The head always comes from the
 * RPC, seconds behind the chain.
 *
 * Swaps alone do not say who traded: the swap's `sender` is whatever router the trader went
 * through. The token's transfers do: a wallet's net change over the transaction is its trade.
 */

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const SWAP = ethers.utils.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const TRANSFER = ethers.utils.id("Transfer(address,address,uint256)");
const STEP = 400_000;
const PARALLEL = 3;
const MAX_WINDOWS = 20;
/** blocks behind the head read again next time: nodes lag each other, and blocks can be replaced */
const SETTLE = 600;
const REFRESH_MS = 4_000;
/** coins kept in memory, least recently asked for dropped first */
const MAX_COINS = 60;

type RawLog = { block: number; index: number; tx: string; topics: string[]; data: string; ts?: number };

/** a swap of the pool: a trade, or the hook turning the fee it took in the coin into USDG */
export type Swap = {
  block: number;
  index: number;
  tx: string;
  ts: number;
  /** price after it, USDG per token */
  price: number;
  usd: number;
  tokens: number;
  buy: boolean;
  hook: boolean;
};
type Transfer = { block: number; index: number; tx: string; from: string; to: string; tokens: number };

type Store = { swaps: Swap[]; transfers: Transfer[]; partial: boolean; upTo: number; at: number; used: number; busy: Promise<void> | null };
const stores = new Map<string, Store>();

const int = (h: string) => (h === "0x" || !h ? 0 : parseInt(h, 16));
const sort = <T extends { block: number; index: number }>(a: T[]) => a.sort((x, y) => x.block - y.block || x.index - y.index);

// ── reading ─────────────────────────────────────────────────────────────────

type EtherscanAnswer = { message: string; result: unknown };

async function etherscanLogs(params: Record<string, string>, fromBlock: number): Promise<RawLog[]> {
  const out = new Map<string, RawLog>();
  let from = fromBlock;
  for (;;) {
    const q = new URLSearchParams({ chainid: String(CHAIN_ID), module: "logs", action: "getLogs", fromBlock: String(from), toBlock: "latest", page: "1", offset: "1000", ...params, apikey: ETHERSCAN_KEY });
    let j: EtherscanAnswer | null = null;
    for (let i = 0; i < 3 && !j; i++) {
      if (i) await new Promise((r) => setTimeout(r, 600 * i));
      const r = await fetch(`https://api.etherscan.io/v2/api?${q}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const body: EtherscanAnswer | null = r?.ok ? await r.json().catch(() => null) : null;
      // a rate limit answers 200 with a string for a result
      if (body && (Array.isArray(body.result) || /no records/i.test(body.message))) j = body;
    }
    if (!j) throw new Error("etherscan logs: no answer");
    const rows = Array.isArray(j.result) ? (j.result as Record<string, string | string[]>[]) : [];
    for (const r of rows) {
      const l: RawLog = { block: int(r.blockNumber as string), index: int(r.logIndex as string), tx: r.transactionHash as string, topics: r.topics as string[], data: r.data as string, ts: int(r.timeStamp as string) };
      out.set(`${l.block}:${l.index}`, l);
    }
    if (rows.length < 1000) return [...out.values()];
    // the next page starts at the last block again (it may have been cut), deduplicated by key
    const last = int(rows[rows.length - 1].blockNumber as string);
    if (last === from) throw new Error("etherscan logs: one block fills a page");
    from = last;
  }
}

async function rpcLogs(filter: { address: string; topics: (string | null)[] }, from: number, to: number): Promise<RawLog[]> {
  const windows: [number, number][] = [];
  for (let f = from; f <= to; f += STEP) windows.push([f, Math.min(to, f + STEP - 1)]);
  const out: RawLog[] = [];
  for (let i = 0; i < windows.length; i += PARALLEL) {
    const got = await Promise.all(windows.slice(i, i + PARALLEL).map(([a, b]) => provider.getLogs({ ...filter, fromBlock: a, toBlock: b })));
    for (const l of got.flat()) out.push({ block: l.blockNumber, index: l.logIndex, tx: l.transactionHash, topics: l.topics, data: l.data });
  }
  return out;
}

/** block → timestamp for the swaps that came without one: read when they are few, interpolated between known blocks otherwise */
async function stamp(logs: RawLog[], known: { block: number; ts: number }[], latest: number): Promise<void> {
  const missing = [...new Set(logs.filter((l) => l.ts == null).map((l) => l.block))].sort((a, b) => a - b);
  if (!missing.length) return;
  const ts = new Map<number, number>();
  if (missing.length <= 25) {
    const blocks = await Promise.all(missing.map((b) => provider.getBlock(b)));
    blocks.forEach((b, i) => ts.set(missing[i], b.timestamp));
  } else {
    // anchors every hundredth block plus both ends: the chain's pace changes over days, not over an hour
    const picks = [...new Set([...missing.filter((_, i) => i % Math.ceil(missing.length / 24) === 0), missing[missing.length - 1], latest])];
    const blocks = await Promise.all(picks.map((b) => provider.getBlock(b)));
    const anchors = [...known, ...blocks.map((b) => ({ block: b.number, ts: b.timestamp }))].sort((a, b) => a.block - b.block);
    for (const m of missing) {
      const hi = anchors.findIndex((a) => a.block >= m);
      const b = anchors[hi === -1 ? anchors.length - 1 : hi];
      const a = anchors[Math.max(0, (hi === -1 ? anchors.length : hi) - 1)];
      ts.set(m, a.block === b.block ? b.ts : Math.round(a.ts + ((b.ts - a.ts) * (m - a.block)) / (b.block - a.block)));
    }
  }
  for (const l of logs) if (l.ts == null) l.ts = ts.get(l.block);
}

const word = (data: string, i: number) => "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64);
const signed = (h: string) => ethers.BigNumber.from(h).fromTwos(256);

function toSwap(l: RawLog, coin: Coin, coinIsToken0: boolean): Swap {
  const [a0, a1] = [signed(word(l.data, 0)), signed(word(l.data, 1))];
  // the pool's deltas are the trader's: negative quote = the trader paid it in
  const quote = coinIsToken0 ? a1 : a0;
  const token = coinIsToken0 ? a0 : a1;
  return {
    block: l.block,
    index: l.index,
    tx: l.tx,
    ts: l.ts ?? 0,
    price: coinPriceFromSqrtP(ethers.BigNumber.from(word(l.data, 2)), coinIsToken0, coin.pairDecimals),
    usd: Math.abs(Number(ethers.utils.formatUnits(quote, coin.pairDecimals))),
    tokens: Math.abs(Number(ethers.utils.formatUnits(token, 18))),
    buy: quote.lt(0),
    hook: l.topics[2].toLowerCase().endsWith(DOPPLER.rehype.toLowerCase().slice(2)),
  };
}

const toTransfer = (l: RawLog): Transfer => ({
  block: l.block,
  index: l.index,
  tx: l.tx,
  from: "0x" + l.topics[1].slice(26).toLowerCase(),
  to: "0x" + l.topics[2].slice(26).toLowerCase(),
  tokens: Number(ethers.utils.formatUnits(l.data, 18)),
});

async function extend(s: Store, coin: Coin): Promise<void> {
  const coinIsToken0 = ethers.BigNumber.from(coin.token).lt(ethers.BigNumber.from(coin.pair));
  const swapFilter = { address: V4_POOL_MANAGER, topics: [SWAP, coin.poolId] };
  const moveFilter = { address: coin.token, topics: [TRANSFER] };
  const latest = await provider.getBlockNumber();

  let from = s.upTo + 1;
  if (ETHERSCAN_KEY && latest - from > STEP / 8) {
    try {
      const [sw, mv] = await Promise.all([
        etherscanLogs({ address: V4_POOL_MANAGER, topic0: SWAP, topic0_1_opr: "and", topic1: coin.poolId }, from),
        etherscanLogs({ address: coin.token, topic0: TRANSFER }, from),
      ]);
      // Etherscan runs a little behind: the last stretch is always the RPC's
      const done = Math.max(from - 1, latest - STEP / 10);
      s.swaps.push(...sort(sw.filter((l) => l.block <= done).map((l) => toSwap(l, coin, coinIsToken0))));
      s.transfers.push(...sort(mv.filter((l) => l.block <= done).map(toTransfer)));
      s.upTo = done;
      from = done + 1;
    } catch (e) {
      console.error(`[trades] ${coin.symbol}: ${(e as Error).message}, history from the RPC`);
    }
  }
  // without Etherscan an old coin would take a hundred windows: nine days is what one request can wait for
  if (latest - from > MAX_WINDOWS * STEP) {
    from = latest - MAX_WINDOWS * STEP;
    s.partial = true;
  }
  const [sw, mv] = await Promise.all([rpcLogs(swapFilter, from, latest), rpcLogs(moveFilter, from, latest)]);
  const lastSwap = s.swaps[s.swaps.length - 1];
  await stamp(sw, lastSwap ? [{ block: lastSwap.block, ts: lastSwap.ts }] : [], latest);
  const keep = <T extends { block: number }>(a: T[]) => a.filter((x) => x.block < from);
  // what lies past the settled block is replaced whole on the next read
  s.swaps = [...keep(s.swaps), ...sort(sw.map((l) => toSwap(l, coin, coinIsToken0)))];
  s.transfers = [...keep(s.transfers), ...sort(mv.map(toTransfer))];
  s.upTo = Math.max(s.upTo, latest - SETTLE);
}

/** the coin's swaps and transfers, current to a few seconds; throws when nothing could be read */
async function read(coin: Coin): Promise<Store> {
  const k = coin.token.toLowerCase();
  let s = stores.get(k);
  if (!s) {
    s = { swaps: [], transfers: [], partial: false, upTo: Math.max(0, coin.launchBlock - 1), at: 0, used: 0, busy: null };
    stores.set(k, s);
    if (stores.size > MAX_COINS) {
      const oldest = [...stores.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      stores.delete(oldest[0]);
    }
  }
  s.used = Date.now();
  if (Date.now() - s.at > REFRESH_MS) {
    const store = s;
    store.busy ??= extend(store, coin)
      .then(() => void (store.at = Date.now()))
      .finally(() => (store.busy = null));
    try {
      await store.busy;
    } catch (e) {
      // seconds-old trades beat none
      if (!store.at) throw e;
    }
  }
  return s;
}

// ── candles ─────────────────────────────────────────────────────────────────

const CANDLES = 1_000;

/**
 * Candles with something in them, oldest first. Each opens where the one before closed and the
 * first at the launch price, so the series has no jumps the pool did not make. The hook's own
 * conversions move the price and are drawn; they are nobody's trade and are not in the volume.
 */
function candlesOf(swaps: Swap[], resolution: Resolution, launchPrice: number): { candles: Candle[]; complete: boolean } {
  const size = RESOLUTIONS[resolution];
  const out: Candle[] = [];
  let prev = launchPrice;
  for (const s of swaps) {
    const time = Math.floor(s.ts / size) * size;
    let c = out[out.length - 1];
    if (!c || time > c.time) {
      c = { time, open: prev, high: prev, low: prev, close: prev, volume: 0, trades: 0, buys: 0 };
      out.push(c);
    }
    c.high = Math.max(c.high, s.price);
    c.low = Math.min(c.low, s.price);
    c.close = s.price;
    if (!s.hook) {
      c.volume = (c.volume ?? 0) + s.usd;
      c.trades = (c.trades ?? 0) + 1;
      if (s.buy) c.buys = (c.buys ?? 0) + 1;
    }
    prev = s.price;
  }
  return { candles: out.slice(-CANDLES), complete: out.length <= CANDLES };
}

// ── who traded ──────────────────────────────────────────────────────────────

const PASS_THROUGH = new Set(
  [V4_POOL_MANAGER, UNIVERSAL_ROUTER, LAUNCH_ROUTER, ...Object.values(DOPPLER), ethers.constants.AddressZero, "0x000000000000000000000000000000000000dead"].map((a) => a.toLowerCase())
);

/**
 * A wallet's trades. Its part of a transaction is its net change in tokens over what the swaps of
 * that transaction moved: most trades are one wallet's, a launch buy is split between many.
 * A token received without a swap in the same transaction is a gift, not a trade.
 */
export function tradesOf(swaps: Swap[], transfers: Transfer[], wallet: string): { ts: number; usd: number; tokens: number; buy: boolean; tx: string }[] {
  const w = wallet.toLowerCase();
  if (PASS_THROUGH.has(w)) return [];
  const net = new Map<string, number>();
  for (const t of transfers) {
    if (t.to === w) net.set(t.tx, (net.get(t.tx) ?? 0) + t.tokens);
    if (t.from === w) net.set(t.tx, (net.get(t.tx) ?? 0) - t.tokens);
  }
  const out = [];
  for (const [tx, delta] of net) {
    if (Math.abs(delta) < 1e-9) continue;
    const mine = swaps.filter((s) => s.tx === tx && !s.hook && s.buy === delta > 0);
    if (!mine.length) continue;
    const usd = mine.reduce((a, s) => a + s.usd, 0);
    const tokens = mine.reduce((a, s) => a + s.tokens, 0);
    // alone in the transaction it paid for all of it, whatever the hook kept of the tokens
    const share = Math.min(1, Math.abs(delta) / tokens);
    out.push({ ts: mine[0].ts, usd: usd * (others(transfers, tx, w) === 0 ? 1 : share), tokens: Math.abs(delta), buy: delta > 0, tx });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** tokens other wallets ended up with (or gave) in a transaction, contracts it only passed through aside */
function others(transfers: Transfer[], tx: string, wallet: string): number {
  const net = new Map<string, number>();
  for (const t of transfers) {
    if (t.tx !== tx) continue;
    net.set(t.to, (net.get(t.to) ?? 0) + t.tokens);
    net.set(t.from, (net.get(t.from) ?? 0) - t.tokens);
  }
  let n = 0;
  for (const [a, v] of net) if (a !== wallet && !PASS_THROUGH.has(a) && Math.abs(v) > 1e-9) n += Math.abs(v);
  return n;
}

/** average cost of what the wallet still holds, USDG per token; a sale keeps the average */
export function averageEntry(trades: { usd: number; tokens: number; buy: boolean }[]): number | null {
  let tokens = 0;
  let cost = 0;
  for (const t of trades) {
    if (t.buy) {
      tokens += t.tokens;
      cost += t.usd;
    } else if (tokens > 0) {
      const left = Math.max(0, tokens - t.tokens);
      cost *= left / tokens;
      tokens = left;
    }
  }
  return tokens >= 1 && cost > 0 ? cost / tokens : null;
}

// ── the chart, in one answer ────────────────────────────────────────────────

const REHYPE = new ethers.utils.Interface([
  "function getFeeSchedule(bytes32) view returns (uint32 startingTime,uint24 startFee,uint24 endFee,uint24 lastFee,uint32 durationSeconds)",
]);
/** end of the launch protection, unix seconds, null without one: written once at launch */
const protection = new Map<string, number | null>();
async function protectionEnd(coin: Coin): Promise<number | null> {
  if (!coin.antiSnipe) return null;
  const hit = protection.get(coin.poolId);
  if (hit !== undefined) return hit;
  try {
    const s = await new ethers.Contract(DOPPLER.rehype, REHYPE, provider).getFeeSchedule(coin.poolId);
    const end = Number(s.durationSeconds) > 0 ? Number(s.startingTime) + Number(s.durationSeconds) : null;
    protection.set(coin.poolId, end);
    return end;
  } catch {
    return null; // a mark less, not a chart less
  }
}

export async function chartData(coin: Coin, resolution: Resolution, opts: { trader?: string; engineWallet?: string }): Promise<ChartData> {
  const [s, end] = await Promise.all([read(coin), protectionEnd(coin)]);
  const launchPrice = coin.openingMcapUsd / (coin.initialSupply ?? 1e9);
  const { candles, complete } = candlesOf(s.swaps, resolution, s.partial ? (s.swaps[0]?.price ?? launchPrice) : launchPrice);
  const now = Math.floor(Date.now() / 1000);
  const engineTrades = opts.engineWallet ? tradesOf(s.swaps, s.transfers, opts.engineWallet).filter((t) => t.buy) : [];
  const mine = opts.trader ? tradesOf(s.swaps, s.transfers, opts.trader) : [];
  const marks: ChartMark[] = [
    ...engineTrades.map((t): ChartMark => ({ kind: "buyback", ts: t.ts, usd: t.usd, tokens: t.tokens })),
    ...mine.map((t): ChartMark => ({ kind: t.buy ? "bought" : "sold", ts: t.ts, usd: t.usd, tokens: t.tokens })),
  ];
  const launchedAt = s.swaps[0]?.ts ?? Math.floor(new Date(coin.createdAt).getTime() / 1000);
  const lines = [
    ...(s.partial ? [] : [{ ts: launchedAt, label: "Launch" }]),
    ...(end != null && end <= now && end - launchedAt >= 60 ? [{ ts: end, label: "Protection over" }] : []),
    ...coin.engineLog
      .filter((e) => e.engine && !e.dropped && (e.effectiveAt ?? e.ts) <= now)
      .map((e) => ({
        ts: e.effectiveAt ?? e.ts,
        label: e.engine!.market ? `${e.engine!.market} ${e.engine!.leverage}x ${e.engine!.side}` : `${e.engine!.leverage}x`,
      })),
  ].sort((a, b) => a.ts - b.ts);
  const highs = s.swaps.map((x) => x.price);
  return {
    candles,
    complete: complete && !s.partial,
    ath: highs.length && !s.partial ? highs.reduce((a, b) => Math.max(a, b), launchPrice) : null,
    launchPrice,
    marks,
    lines,
    entry: averageEntry(mine),
  };
}

/** the swaps for other readers of the same history (the live feed) */
export async function coinSwaps(coin: Coin, engineWallet?: string) {
  const s = await read(coin);
  const buybacks = new Set(engineWallet ? tradesOf(s.swaps, s.transfers, engineWallet).map((t) => t.tx) : []);
  return { swaps: s.swaps, transfers: s.transfers, buybacks };
}
