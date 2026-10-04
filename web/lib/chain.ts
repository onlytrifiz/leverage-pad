import { ethers } from "ethers";
import { RPC_URL, PINATA_GATEWAY } from "./config";
import { USDG, DOPPLER, V4_POOL_MANAGER, LAUNCH_ROUTER, LAUNCH_FEE_HUB, ROUTER_DEPLOY_BLOCK } from "./clientConfig";
import type { Candle, Coin, FeedItem } from "./types";
import { multicallPerItem, type Call } from "./multicall";
import { LEGACY_TP } from "./doppler";

/**
 * On-chain reads for coins launched through the multiply router (Uniswap v4 via
 * Doppler). Read-only, public RPC. Prices are floats for display only; nothing
 * here builds a transaction.
 *
 * Sources, in order of authority:
 *   - the router's `MultiplyLaunch` events: which coins exist, their pool ids
 *     and launch settings;
 *   - the token's IPFS metadata: name, image and the engine parameters
 *     (`multiply{market, side, leverage, takeProfitPct, managed, creator}`);
 *   - the PoolManager: price and liquidity (`extsload` of the pool's slots);
 *   - the PoolManager `Swap` log per pool id: candles, trades and the hook's
 *     own fee conversions.
 */

// Dentro il bundle di Next il trasporto HTTP interno di ethers v5 fallisce con
// "missing response" (il suo getUrl non gira bene nel runtime server di Next).
// Il fetch nativo di Node invece funziona: sovrascriviamo send() per usarlo.
// A dropped connection, a timeout or a 429/5xx is retried with a short backoff: one transient
// network error on a public RPC must not take a whole page down. An RPC-level error (a revert,
// a bad range) is an answer, and is thrown straight away.
let rpcId = 0;
const RPC_ATTEMPTS = 3;
const RPC_TIMEOUT_MS = 15_000;
class FetchRpcProvider extends ethers.providers.StaticJsonRpcProvider {
  async send(method: string, params: unknown[]): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
    let last: unknown;
    for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      let res: Response;
      try {
        res = await fetch(this.connection.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      } catch (e) {
        last = e;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`RPC ${method}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
      return json.result;
    }
    throw last;
  }
}

export const provider = new FetchRpcProvider(RPC_URL, { chainId: 4663, name: "robinhood" });

const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function tokenURI() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const POOL_MANAGER_ABI = [
  "function extsload(bytes32 slot) view returns (bytes32)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
];
// the engine event of the router before the engine upgrade: a risk profile (0 safe, 1 balanced,
// 2 degen) instead of a take-profit. Kept apart from ROUTER_ABI, where an overloaded event name
// would make getEventTopic ambiguous.
const LEGACY_ENGINE_IFACE = new ethers.utils.Interface([
  "event MultiplyEngine(address indexed asset, string market, uint8 side, uint8 leverage, uint8 risk)",
]);
const LEGACY_RISKS = ["safe", "balanced", "degen"];
const ROUTER_ABI = [
  "event MultiplyLaunch(address indexed asset, address indexed launcher, bytes32 indexed poolId, uint24 fee, bool antiSnipe, uint256 mcap, int24 tick, uint128 firstBuy, uint128 firstBuyOut, string tokenURI)",
  // the engine at launch, validated and emitted by the router (metadata is for the image)
  "event MultiplyEngine(address indexed asset, string market, uint8 side, uint8 leverage, uint16 takeProfitPct, bool managed, address indexed creator)",
  // the engine now: a managed coin's change, or the owner's override, after the launch event
  "function engineOf(address asset) view returns ((string market,uint8 side,uint8 leverage,uint16 takeProfitPct,bool managed,address creator,uint8 pendingLeverage,uint16 pendingTakeProfitPct,uint64 pendingAt))",
  // the coin's fee sink: zero for coins launched before the sink upgrade (their fees went to the hub)
  "function sinkOf(address asset) view returns (address)",
];

const ERC20_IFACE = new ethers.utils.Interface(ERC20_ABI);
const PM_IFACE = new ethers.utils.Interface(POOL_MANAGER_ABI);
const ROUTER_IFACE = new ethers.utils.Interface(ROUTER_ABI);

export const erc20 = (a: string) => new ethers.Contract(a, ERC20_ABI, provider);

const Q96 = Math.pow(2, 96);
const PAIR_DECIMALS = 6;
const INITIAL_SUPPLY = 1_000_000_000;

/** prezzo della coin in unita' quote, da sqrtPriceX96 (coin 18 dec) */
export function coinPriceFromSqrtP(
  sqrtPriceX96: ethers.BigNumber,
  coinIsToken0: boolean,
  pairDecimals: number
): number {
  const ratio = Number(sqrtPriceX96.toString()) / Q96;
  const p = ratio * ratio; // token1 raw per token0 raw
  const rawQuotePerCoin = coinIsToken0 ? p : 1 / p;
  return rawQuotePerCoin * Math.pow(10, 18 - pairDecimals);
}

const coinIsToken0Of = (coin: Pick<Coin, "token" | "pair">) =>
  ethers.BigNumber.from(coin.token).lt(ethers.BigNumber.from(coin.pair));

// ── v4 storage layout: pools[poolId] lives at slot 6 of the PoolManager ─────
const POOLS_SLOT = 6;
const poolBaseSlot = (poolId: string) =>
  ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256"], [poolId, POOLS_SLOT]));
const liquiditySlot = (poolId: string) =>
  ethers.BigNumber.from(poolBaseSlot(poolId)).add(3).toHexString(); // slot0, feeGrowth0, feeGrowth1, liquidity

function decodeSlot0(word: string) {
  const s0 = ethers.BigNumber.from(word);
  const sqrtPriceX96 = s0.and(ethers.BigNumber.from(1).shl(160).sub(1));
  let tick = s0.shr(160).and(0xffffff).toNumber();
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick, lpFee: s0.shr(208).and(0xffffff).toNumber() };
}

// ── coins from the router's launch events ───────────────────────────────────

type Metadata = {
  name?: string;
  symbol?: string;
  image?: string;
  description?: string;
  website?: string;
  x?: string;
  telegram?: string;
  multiply?: {
    market?: string;
    side?: string;
    leverage?: number;
    takeProfitPct?: number;
    managed?: boolean;
    /** coins launched before custom take-profits */
    risk?: string;
    creator?: string | null;
  };
};

const metadataCache = new Map<string, Promise<Metadata | null>>();

const IPFS_HOST = PINATA_GATEWAY ? `https://${PINATA_GATEWAY}/ipfs/` : "https://ipfs.io/ipfs/";
/** an ipfs:// image as a URL a browser can load; https passes through, anything else is dropped */
const imageUrl = (u?: string) =>
  !u ? undefined : u.startsWith("ipfs://") ? IPFS_HOST + u.slice(7) : /^https:\/\//.test(u) ? u : undefined;
/** a social link from metadata, shown only when it is plain https */
const link = (u?: string) => (typeof u === "string" && /^https:\/\/[^\s"<>]+$/.test(u) ? u : undefined);

/** ipfs:// JSON through the dedicated gateway, data: URIs decoded inline; cached per URI */
function fetchMetadata(uri: string): Promise<Metadata | null> {
  if (!uri) return Promise.resolve(null);
  let p = metadataCache.get(uri);
  if (!p) {
    p = (async () => {
      try {
        if (uri.startsWith("data:application/json;base64,")) {
          return JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8")) as Metadata;
        }
        if (uri.startsWith("data:application/json,")) return JSON.parse(decodeURIComponent(uri.slice(22))) as Metadata;
        if (uri.startsWith("ipfs://")) {
          const cid = uri.slice(7);
          const r = await fetch(IPFS_HOST + cid, { next: { revalidate: 3600 } });
          if (!r.ok) return null;
          return (await r.json()) as Metadata;
        }
        return null;
      } catch {
        return null;
      }
    })();
    metadataCache.set(uri, p);
  }
  return p;
}

const SIDES = new Set(["long", "short"]);

let coinsCache: { at: number; coins: Coin[] } | null = null;
const COINS_TTL_MS = 10_000;

/**
 * Every coin launched through the router, newest first. One log query from the
 * router's deploy block (adaptive range), one multicall for names and symbols,
 * one metadata fetch per coin (cached). Coins whose metadata does not carry the
 * engine settings still appear, with the engine marked unknown.
 */
export async function loadRouterCoins(): Promise<Coin[]> {
  if (coinsCache && Date.now() - coinsCache.at < COINS_TTL_MS) return coinsCache.coins;
  try {
    return await scanRouterCoins();
  } catch (e) {
    // the RPC is down past its retries: the last good list beats an error page
    if (coinsCache) {
      console.error(`[loadRouterCoins] serving the last list: ${(e as Error).message?.slice(0, 120)}`);
      return coinsCache.coins;
    }
    throw e;
  }
}

async function scanRouterCoins(): Promise<Coin[]> {
  const latest = await provider.getBlockNumber();
  const launchTopic = ROUTER_IFACE.getEventTopic("MultiplyLaunch");
  const engineTopic = ROUTER_IFACE.getEventTopic("MultiplyEngine");
  const legacyEngineTopic = LEGACY_ENGINE_IFACE.getEventTopic("MultiplyEngine");
  // The router's logs by ADDRESS only, topics filtered here: the node allows 400k blocks for a
  // plain query but only 100k with an OR on topic0 (blocks are ~0.1 s, so that is under three
  // hours). Windows are fetched in parallel: the scan starts at the first real launch, not at
  // the router's deploy, but it still grows with the chain.
  const STEP = 400_000;
  const windows: [number, number][] = [];
  for (let from = ROUTER_DEPLOY_BLOCK; from <= latest; from += STEP) windows.push([from, Math.min(latest, from + STEP - 1)]);
  let missed = 0;
  const chunks = await Promise.all(
    windows.map(([from, to]) =>
      provider.getLogs({ address: LAUNCH_ROUTER, fromBlock: from, toBlock: to }).catch((e) => {
        missed++;
        console.error(`[loadRouterCoins] getLogs ${from}-${to}: ${(e as Error).message?.slice(0, 120)}`);
        return [] as ethers.providers.Log[];
      })
    )
  );
  // a window that failed would make coins vanish: keep the last full list rather than cache a short one
  if (missed > 0 && coinsCache) return coinsCache.coins;
  const logs = chunks
    .flat()
    .filter((l) => l.topics[0] === launchTopic || l.topics[0] === engineTopic || l.topics[0] === legacyEngineTopic);
  // the engine event of each asset, emitted in the same transaction as its launch
  const engines = new Map<
    string,
    { market: string; side: "long" | "short"; leverage: number; takeProfitPct: number; managed: boolean; creator: string }
  >();
  for (const l of logs) {
    if (l.topics[0] === legacyEngineTopic) {
      const a = LEGACY_ENGINE_IFACE.parseLog(l).args;
      engines.set(String(a.asset).toLowerCase(), {
        market: String(a.market),
        side: Number(a.side) === 1 ? "short" : "long",
        leverage: Number(a.leverage),
        takeProfitPct: LEGACY_TP[LEGACY_RISKS[Number(a.risk)]] ?? 50,
        managed: false,
        creator: "",
      });
      continue;
    }
    if (l.topics[0] !== engineTopic) continue;
    const a = ROUTER_IFACE.parseLog(l).args;
    engines.set(String(a.asset).toLowerCase(), {
      market: String(a.market),
      side: Number(a.side) === 1 ? "short" : "long",
      leverage: Number(a.leverage),
      takeProfitPct: Number(a.takeProfitPct),
      managed: Boolean(a.managed),
      creator: String(a.creator),
    });
  }
  const launches = logs.filter((l) => l.topics[0] === launchTopic).map((l) => ({ log: l, ev: ROUTER_IFACE.parseLog(l).args }));
  if (launches.length === 0) {
    coinsCache = { at: Date.now(), coins: [] };
    return [];
  }
  const tOf = await blockTimeEstimator(launches[0].log.blockNumber, latest);
  const names = await multicallPerItem(provider, launches, ({ ev }) => [
    { target: ev.asset, iface: ERC20_IFACE, fn: "name" },
    { target: ev.asset, iface: ERC20_IFACE, fn: "symbol" },
    // `sinkOf` reverts as a whole on the pre-upgrade router (no such selector): per-call
    // failure tolerance turns that into a null, and the hub is shown instead
    { target: LAUNCH_ROUTER, iface: ROUTER_IFACE, fn: "sinkOf", args: [ev.asset] },
    // the engine as it stands now; null on a router without stored engines
    { target: LAUNCH_ROUTER, iface: ROUTER_IFACE, fn: "engineOf", args: [ev.asset] },
  ]).catch(() => launches.map(() => [null, null, null, null]));
  const metas = await Promise.all(launches.map(({ ev }) => fetchMetadata(String(ev.tokenURI))));

  const coins: Coin[] = launches.map(({ log, ev }, i) => {
    const m = metas[i];
    // the router's event is the engine; the metadata is only consulted for coins launched
    // before the event existed (none on this router) and for the image
    const onChain = engines.get(String(ev.asset).toLowerCase());
    const eng = m?.multiply ?? {};
    const side = onChain?.side ?? (SIDES.has(String(eng.side)) ? (eng.side as "long" | "short") : "long");
    // engineOf is the current engine; the launch event is the fallback, metadata the last resort
    const now = names[i]?.[3]?.[0] as
      | { creator: string; leverage: number; takeProfitPct: number; managed: boolean; pendingLeverage: number; pendingTakeProfitPct: number; pendingAt: ethers.BigNumber }
      | undefined;
    const live = now && !ethers.BigNumber.from(now.creator).isZero() ? now : undefined;
    const takeProfitPct =
      (live ? Number(live.takeProfitPct) : undefined) ??
      onChain?.takeProfitPct ??
      (Number(eng.takeProfitPct) || LEGACY_TP[String(eng.risk)] || 50);
    const pendingAt = live ? Number(live.pendingAt) : 0;
    const sink: string | undefined = names[i]?.[2]?.[0];
    const feeDestination = sink && !ethers.BigNumber.from(sink).isZero() ? sink : LAUNCH_FEE_HUB;
    return {
      token: ev.asset,
      name: names[i]?.[0]?.[0] ?? m?.name ?? "",
      symbol: names[i]?.[1]?.[0] ?? m?.symbol ?? "",
      poolId: ev.poolId,
      pair: USDG,
      pairSymbol: "USDG",
      pairDecimals: PAIR_DECIMALS,
      fee: Number(ev.fee),
      antiSnipe: Boolean(ev.antiSnipe),
      openingMcapUsd: Number(ethers.utils.formatUnits(ev.mcap, PAIR_DECIMALS)),
      launcher: ev.launcher,
      subWallet: feeDestination,
      creator: onChain?.creator || (eng.creator && /^0x[0-9a-fA-F]{40}$/.test(eng.creator) ? eng.creator : ev.launcher),
      market: onChain?.market ?? (String(eng.market ?? "").toUpperCase() || "?"),
      side,
      leverage: (live ? Number(live.leverage) : undefined) ?? onChain?.leverage ?? (Number(eng.leverage) || 0),
      takeProfitPct,
      managed: live ? Boolean(live.managed) : (onChain?.managed ?? false),
      pendingEngine:
        pendingAt > 0 && live
          ? { leverage: Number(live.pendingLeverage), takeProfitPct: Number(live.pendingTakeProfitPct), effectiveAt: pendingAt }
          : null,
      tokenURI: String(ev.tokenURI),
      image: imageUrl(m?.image),
      socials: { website: link(m?.website), x: link(m?.x), telegram: link(m?.telegram) },
      initialSupply: INITIAL_SUPPLY,
      launchBlock: log.blockNumber,
      createdAt: new Date(tOf(log.blockNumber) * 1000).toISOString(),
    };
  });
  coins.reverse();
  coinsCache = { at: Date.now(), coins };
  return coins;
}

// ── pool state, batched ─────────────────────────────────────────────────────

export type CoinChainState = {
  priceUsd: number | null;
  totalSupply: number | null;
  marketCapUsd: number | null;
  sqrtPriceX96: string | null;
  liquidity: string | null;
  tick: number | null;
  coinIsToken0: boolean;
  /** fee destination balances, only requested by the detail read */
  subQuote: number | null;
  subCoin: number | null;
};

const EMPTY_STATE = (coin: Coin): CoinChainState => ({
  priceUsd: null,
  totalSupply: null,
  marketCapUsd: null,
  sqrtPriceX96: null,
  liquidity: null,
  tick: null,
  coinIsToken0: coinIsToken0Of(coin),
  subQuote: null,
  subCoin: null,
});

/**
 * Price, liquidity, supply and (optionally) the fee destination's balances for
 * many coins in one Multicall3 call. A pool that cannot be read yields nulls
 * for that coin only.
 */
export async function readCoinStates(
  coins: Coin[],
  { withSubWallet = false }: { withSubWallet?: boolean } = {}
): Promise<Map<string, CoinChainState>> {
  const out = new Map<string, CoinChainState>();
  if (coins.length === 0) return out;
  const perCoin = withSubWallet ? 5 : 3;
  let groups: (ethers.utils.Result | null)[][];
  try {
    groups = await multicallPerItem(provider, coins, (coin) => {
      const calls: Call[] = [
        { target: V4_POOL_MANAGER, iface: PM_IFACE, fn: "extsload", args: [poolBaseSlot(coin.poolId)] },
        { target: V4_POOL_MANAGER, iface: PM_IFACE, fn: "extsload", args: [liquiditySlot(coin.poolId)] },
        { target: coin.token, iface: ERC20_IFACE, fn: "totalSupply" },
      ];
      if (withSubWallet) {
        calls.push(
          { target: coin.pair, iface: ERC20_IFACE, fn: "balanceOf", args: [coin.subWallet] },
          { target: coin.token, iface: ERC20_IFACE, fn: "balanceOf", args: [coin.subWallet] }
        );
      }
      return calls;
    });
  } catch (e) {
    console.error(`[readCoinStates] multicall failed: ${(e as Error).message?.slice(0, 160)}`);
    for (const coin of coins) out.set(coin.token.toLowerCase(), EMPTY_STATE(coin));
    return out;
  }
  coins.forEach((coin, i) => {
    const g = groups[i] ?? [];
    if (g.length !== perCoin) {
      out.set(coin.token.toLowerCase(), EMPTY_STATE(coin));
      return;
    }
    const [slot0Word, liqWord, supply, quoteBal, coinBal] = g;
    const coinIsToken0 = coinIsToken0Of(coin);
    const slot0 = slot0Word ? decodeSlot0(slot0Word[0]) : null;
    const uninitialized = slot0 ? slot0.sqrtPriceX96.isZero() : true;
    const priceUsd = slot0 && !uninitialized ? coinPriceFromSqrtP(slot0.sqrtPriceX96, coinIsToken0, coin.pairDecimals) : null;
    const totalSupply = supply ? Number(ethers.utils.formatUnits(supply[0], 18)) : null;
    out.set(coin.token.toLowerCase(), {
      priceUsd,
      totalSupply,
      marketCapUsd: priceUsd != null && totalSupply != null ? priceUsd * totalSupply : null,
      sqrtPriceX96: slot0 ? slot0.sqrtPriceX96.toString() : null,
      liquidity: liqWord ? ethers.BigNumber.from(liqWord[0]).and(ethers.BigNumber.from(1).shl(128).sub(1)).toString() : null,
      tick: slot0 ? slot0.tick : null,
      coinIsToken0,
      subQuote: quoteBal ? Number(ethers.utils.formatUnits(quoteBal[0], coin.pairDecimals)) : null,
      subCoin: coinBal ? Number(ethers.utils.formatUnits(coinBal[0], 18)) : null,
    });
  });
  return out;
}

// ── logs ────────────────────────────────────────────────────────────────────

/** stima timestamp dei blocchi: due letture, interpolazione lineare */
async function blockTimeEstimator(fromBlock: number, latest: number) {
  const [a, b] = await Promise.all([provider.getBlock(Math.max(0, fromBlock)), provider.getBlock(latest)]);
  const span = Math.max(1, latest - fromBlock);
  const avg = (b.timestamp - a.timestamp) / span;
  return (bn: number) => Math.round(b.timestamp - (latest - bn) * avg);
}

/** getLogs con range adattivo: dimezza finche' l'RPC non accetta */
async function getLogsAdaptive(filter: ethers.providers.Filter, latest: number, maxRange: number) {
  let range = Math.min(maxRange, latest);
  while (range >= 2000) {
    try {
      return { logs: await provider.getLogs({ ...filter, fromBlock: latest - range, toBlock: latest }), fromBlock: latest - range };
    } catch {
      range = Math.floor(range / 2);
    }
  }
  return { logs: [], fromBlock: latest };
}

const CANDLE_BUCKET_S = 15 * 60;
const LOG_RANGE_BLOCKS = 400_000;

/** every Swap on the coin's pool, newest range the RPC accepts */
async function poolSwaps(coin: Coin, latest: number) {
  return getLogsAdaptive(
    { address: V4_POOL_MANAGER, topics: [PM_IFACE.getEventTopic("Swap"), coin.poolId] },
    latest,
    Math.min(LOG_RANGE_BLOCKS, Math.max(2000, latest - coin.launchBlock + 1))
  );
}

export async function poolCandles(coin: Coin): Promise<Candle[]> {
  const latest = await provider.getBlockNumber();
  const { logs, fromBlock } = await poolSwaps(coin, latest);
  if (!logs.length) return [];
  const tOf = await blockTimeEstimator(fromBlock, latest);
  const coinIsToken0 = coinIsToken0Of(coin);
  const points = logs.map((l) => {
    const ev = PM_IFACE.parseLog(l);
    return { t: tOf(l.blockNumber), p: coinPriceFromSqrtP(ev.args.sqrtPriceX96, coinIsToken0, coin.pairDecimals) };
  });
  const buckets = new Map<number, Candle>();
  for (const { t, p } of points) {
    const bt = Math.floor(t / CANDLE_BUCKET_S) * CANDLE_BUCKET_S;
    const c = buckets.get(bt);
    if (!c) buckets.set(bt, { time: bt, open: p, high: p, low: p, close: p });
    else {
      c.high = Math.max(c.high, p);
      c.low = Math.min(c.low, p);
      c.close = p;
    }
  }
  const sorted = [...buckets.values()].sort((a, b) => a.time - b.time);
  const filled: Candle[] = [];
  for (const c of sorted) {
    const prev = filled[filled.length - 1];
    if (prev) {
      for (let t = prev.time + CANDLE_BUCKET_S; t < c.time; t += CANDLE_BUCKET_S) {
        filled.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close });
      }
      c.open = prev.close;
    }
    filled.push(c);
  }
  return filled;
}

/**
 * Fees the pool has produced so far, in USDG, from its swaps: the hook takes
 * `fee` of the output leg of every trade, and converts coin-side fees to USDG in
 * the same call. The hook's own conversion swaps (sender = the Rehype hook) are
 * not trades and are skipped. Exact at the flat fee; during a protection window
 * the real take is higher.
 */
export async function poolFeesUsd(coin: Coin): Promise<number> {
  const latest = await provider.getBlockNumber();
  const { logs } = await poolSwaps(coin, latest);
  const coinIsToken0 = coinIsToken0Of(coin);
  let usd = 0;
  for (const l of logs) {
    const ev = PM_IFACE.parseLog(l);
    if (String(ev.args.sender).toLowerCase() === DOPPLER.rehype.toLowerCase()) continue;
    const a0 = ev.args.amount0 as ethers.BigNumber;
    const a1 = ev.args.amount1 as ethers.BigNumber;
    const quoteDelta = coinIsToken0 ? a1 : a0;
    const coinDelta = coinIsToken0 ? a0 : a1;
    // fee on the output leg: a buy pays in coin (valued at the trade's own price), a sell in USDG
    const price = coinPriceFromSqrtP(ev.args.sqrtPriceX96, coinIsToken0, coin.pairDecimals);
    const quoteUsd = Math.abs(Number(ethers.utils.formatUnits(quoteDelta, coin.pairDecimals)));
    const coinOutUsd = Math.abs(Number(ethers.utils.formatUnits(coinDelta, 18))) * price;
    const buying = quoteDelta.lt(0); // the pool's delta: negative quote = quote left the trader
    usd += ((buying ? coinOutUsd : quoteUsd) * coin.fee) / 1_000_000;
  }
  return usd;
}

/** live feed: trades, the hook's fee conversions, burns — from real logs */
export async function coinFeed(coin: Coin): Promise<FeedItem[]> {
  const latest = await provider.getBlockNumber();
  const token = erc20(coin.token);
  const transferTopic = token.interface.getEventTopic("Transfer");
  const [swaps, burns, burnsDead] = await Promise.all([
    poolSwaps(coin, latest),
    getLogsAdaptive({ address: coin.token, topics: [transferTopic, null, ethers.utils.hexZeroPad(ethers.constants.AddressZero, 32)] }, latest, LOG_RANGE_BLOCKS),
    getLogsAdaptive({ address: coin.token, topics: [transferTopic, null, ethers.utils.hexZeroPad("0x000000000000000000000000000000000000dEaD", 32)] }, latest, LOG_RANGE_BLOCKS),
  ]);
  const fromBlock = Math.min(swaps.fromBlock, burns.fromBlock, burnsDead.fromBlock);
  const tOf = await blockTimeEstimator(fromBlock, latest);
  const items: FeedItem[] = [];
  const fmtQ = (v: number) => v.toFixed(2);
  const fmtC = (v: ethers.BigNumber) => Math.round(Number(ethers.utils.formatUnits(v, 18))).toLocaleString("en-US");
  const coinIsToken0 = coinIsToken0Of(coin);

  for (const l of [...burns.logs, ...burnsDead.logs]) {
    const ev = token.interface.parseLog(l);
    if (ev.args.from === ethers.constants.AddressZero || ev.args.value.isZero()) continue; // mint, or the Airlock's zero-value transfer at creation
    items.push({ kind: "burn", text: "burned", amountText: `${fmtC(ev.args.value)} ${coin.symbol}`, tone: "accent", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
  }
  for (const l of swaps.logs) {
    const ev = PM_IFACE.parseLog(l);
    const p = coinPriceFromSqrtP(ev.args.sqrtPriceX96, coinIsToken0, coin.pairDecimals);
    const quoteDelta: ethers.BigNumber = coinIsToken0 ? ev.args.amount1 : ev.args.amount0;
    const quoteUsd = Math.abs(Number(ethers.utils.formatUnits(quoteDelta, coin.pairDecimals)));
    const fromHook = String(ev.args.sender).toLowerCase() === DOPPLER.rehype.toLowerCase();
    if (fromHook) {
      items.push({ kind: "collect", text: "fees → USDG", amountText: `$${fmtQ(quoteUsd)}`, tone: "plain", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
      continue;
    }
    const isBuyback = String(ev.args.sender).toLowerCase() === coin.subWallet.toLowerCase();
    const buying = quoteDelta.lt(0);
    if (isBuyback) {
      items.push({ kind: "buyback", text: "buyback", amountText: `$${fmtQ(quoteUsd)}`, tone: "accent", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
    } else {
      items.push({ kind: "tick", text: `trade @ ${p.toPrecision(4)}`, amountText: `${buying ? "+" : "−"}$${fmtQ(quoteUsd)}`, tone: buying ? "up" : "down", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
    }
  }
  return items.sort((a, b) => b.ts - a.ts).slice(0, 40);
}
