import { ethers } from "ethers";
import { RPC_URL, LOCKER } from "./config";
import type { Candle, Coin, FeedItem } from "./types";

/**
 * Letture on-chain (sola lettura, RPC pubblico). Il prezzo viene da slot0 del
 * pool; candele e live feed dai log (Swap, Collected, Transfer). I numeri float
 * servono SOLO per la visualizzazione, mai per costruire transazioni.
 */

// Dentro il bundle di Next il trasporto HTTP interno di ethers v5 fallisce con
// "missing response" (il suo getUrl non gira bene nel runtime server di Next).
// Il fetch nativo di Node invece funziona: sovrascriviamo send() per usarlo.
let rpcId = 0;
class FetchRpcProvider extends ethers.providers.StaticJsonRpcProvider {
  async send(method: string, params: unknown[]): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
    const res = await fetch(this.connection.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const json = await res.json();
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
    return json.result;
  }
}

export const provider = new FetchRpcProvider(RPC_URL, { chainId: 4663, name: "robinhood" });

const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const LOCKER_ABI = [
  "event Collected(uint256 indexed tokenId, address indexed feeRecipient, uint256 amount0, uint256 amount1)",
];

export const erc20 = (a: string) => new ethers.Contract(a, ERC20_ABI, provider);
export const poolContract = (a: string) => new ethers.Contract(a, POOL_ABI, provider);

const Q96 = Math.pow(2, 96);

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

export async function poolState(coin: Coin) {
  const pool = poolContract(coin.pool);
  const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const coinIsToken0 = ethers.BigNumber.from(coin.token).lt(ethers.BigNumber.from(coin.pair));
  const priceUsd = coinPriceFromSqrtP(slot0.sqrtPriceX96, coinIsToken0, coin.pairDecimals);
  return { sqrtPriceX96: slot0.sqrtPriceX96 as ethers.BigNumber, liquidity, coinIsToken0, priceUsd };
}

/** stima timestamp dei blocchi: due letture, interpolazione lineare */
async function blockTimeEstimator(fromBlock: number, latest: number) {
  const [a, b] = await Promise.all([
    provider.getBlock(Math.max(0, fromBlock)),
    provider.getBlock(latest),
  ]);
  const span = Math.max(1, latest - fromBlock);
  const avg = (b.timestamp - a.timestamp) / span;
  return (bn: number) => Math.round(b.timestamp - (latest - bn) * avg);
}

/** getLogs con range adattivo: dimezza finche' l'RPC non accetta */
async function getLogsAdaptive(filter: ethers.providers.Filter, latest: number, maxRange: number) {
  let range = Math.min(maxRange, latest);
  while (range >= 2000) {
    try {
      return {
        logs: await provider.getLogs({ ...filter, fromBlock: latest - range, toBlock: latest }),
        fromBlock: latest - range,
      };
    } catch {
      range = Math.floor(range / 2);
    }
  }
  return { logs: [], fromBlock: latest };
}

const CANDLE_BUCKET_S = 15 * 60;
const LOG_RANGE_BLOCKS = 400_000;

export async function poolCandles(coin: Coin): Promise<Candle[]> {
  const latest = await provider.getBlockNumber();
  const pool = poolContract(coin.pool);
  const { logs, fromBlock } = await getLogsAdaptive(
    { address: coin.pool, topics: [pool.interface.getEventTopic("Swap")] },
    latest,
    LOG_RANGE_BLOCKS
  );
  if (!logs.length) return [];
  const tOf = await blockTimeEstimator(fromBlock, latest);
  const coinIsToken0 = ethers.BigNumber.from(coin.token).lt(ethers.BigNumber.from(coin.pair));

  const points = logs.map((l) => {
    const ev = pool.interface.parseLog(l);
    return {
      t: tOf(l.blockNumber),
      p: coinPriceFromSqrtP(ev.args.sqrtPriceX96, coinIsToken0, coin.pairDecimals),
    };
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
  // riempi i buchi trascinando la close (candele piatte)
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

/** live feed: collect del locker, burn, buyback, payout — dai log reali */
export async function coinFeed(coin: Coin, creator: string, treasury: string): Promise<FeedItem[]> {
  const latest = await provider.getBlockNumber();
  const token = erc20(coin.token);
  const quote = erc20(coin.pair);
  const pool = poolContract(coin.pool);
  const transferTopic = token.interface.getEventTopic("Transfer");
  const subPadded = ethers.utils.hexZeroPad(coin.subWallet, 32);

  const queries: Promise<{ logs: ethers.providers.Log[]; fromBlock: number }>[] = [
    // burn: Transfer(sub → 0x0) del token della coin
    getLogsAdaptive(
      { address: coin.token, topics: [transferTopic, subPadded, ethers.utils.hexZeroPad(ethers.constants.AddressZero, 32)] },
      latest, LOG_RANGE_BLOCKS
    ),
    // movimenti quote in USCITA dal sub-wallet (payout creator/treasury, deposito perp)
    getLogsAdaptive(
      { address: coin.pair, topics: [transferTopic, subPadded] },
      latest, LOG_RANGE_BLOCKS
    ),
    // swap sul pool (i buyback hanno recipient = sub-wallet)
    getLogsAdaptive(
      { address: coin.pool, topics: [pool.interface.getEventTopic("Swap")] },
      latest, LOG_RANGE_BLOCKS
    ),
  ];
  if (LOCKER) {
    const lockerC = new ethers.Contract(LOCKER, LOCKER_ABI, provider);
    queries.push(
      getLogsAdaptive(
        {
          address: LOCKER,
          topics: [
            lockerC.interface.getEventTopic("Collected"),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(coin.lpTokenId).toHexString(), 32),
          ],
        },
        latest, LOG_RANGE_BLOCKS
      )
    );
  }

  const results = await Promise.all(queries);
  const fromBlock = Math.min(...results.map((r) => r.fromBlock));
  const tOf = await blockTimeEstimator(fromBlock, latest);
  const items: FeedItem[] = [];
  const fmtQ = (v: ethers.BigNumber) =>
    Number(ethers.utils.formatUnits(v, coin.pairDecimals)).toFixed(2);
  const fmtC = (v: ethers.BigNumber) =>
    Math.round(Number(ethers.utils.formatUnits(v, 18))).toLocaleString("en-US");

  for (const l of results[0].logs) {
    const ev = token.interface.parseLog(l);
    items.push({ kind: "burn", text: "burned", amountText: `${fmtC(ev.args.value)} ${coin.symbol}`, tone: "accent", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
  }
  for (const l of results[1].logs) {
    const ev = quote.interface.parseLog(l);
    const to = String(ev.args.to).toLowerCase();
    if (to === creator.toLowerCase())
      items.push({ kind: "creator", text: "creator paid", amountText: `$${fmtQ(ev.args.value)}`, tone: "accent", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
    else if (treasury && to === treasury.toLowerCase())
      items.push({ kind: "treasury", text: "treasury paid", amountText: `$${fmtQ(ev.args.value)}`, tone: "plain", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
    else if (to !== coin.pool.toLowerCase())
      items.push({ kind: "deposit", text: "perp deposit → lighter", amountText: `$${fmtQ(ev.args.value)}`, tone: "accent", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
  }
  const coinIsToken0 = ethers.BigNumber.from(coin.token).lt(ethers.BigNumber.from(coin.pair));
  for (const l of results[2].logs) {
    const ev = pool.interface.parseLog(l);
    const p = coinPriceFromSqrtP(ev.args.sqrtPriceX96, coinIsToken0, coin.pairDecimals);
    const isBuyback = String(ev.args.recipient).toLowerCase() === coin.subWallet.toLowerCase();
    const quoteIn = coinIsToken0 ? ev.args.amount1 : ev.args.amount0;
    if (isBuyback) {
      items.push({ kind: "buyback", text: "buyback", amountText: `$${fmtQ(quoteIn.abs())}`, tone: "accent", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
    } else {
      const buying = quoteIn.gt(0); // quote entra nel pool = qualcuno compra la coin
      items.push({ kind: "tick", text: `trade @ ${p.toPrecision(4)}`, amountText: `${buying ? "+" : "−"}$${fmtQ(quoteIn.abs())}`, tone: buying ? "up" : "down", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
    }
  }
  if (results[3]) {
    for (const l of results[3].logs) {
      const lockerC = new ethers.Contract(LOCKER, LOCKER_ABI, provider);
      const ev = lockerC.interface.parseLog(l);
      const quoteAmt = coinIsToken0 ? ev.args.amount1 : ev.args.amount0;
      items.push({ kind: "collect", text: "fees collected", amountText: `$${fmtQ(quoteAmt)}`, tone: "plain", txHash: l.transactionHash, ts: tOf(l.blockNumber) });
    }
  }
  return items.sort((a, b) => b.ts - a.ts).slice(0, 40);
}
