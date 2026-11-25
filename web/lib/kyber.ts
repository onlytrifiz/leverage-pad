import { USDG, NATIVE } from "./clientConfig";
import { loadRouterCoins } from "./chain";

/**
 * KyberSwap, server side: routes between ETH, USDG and our tokens. It knows the tokens' pools
 * (`uniswap-v4-doppler`), the fee the Rehype hook takes and its decay during a launch's protection.
 * With our key the quotas are ours; without it the public host, under a client id.
 */

const KEY = process.env.KYBER_API_KEY || "";
const HOST = KEY ? "https://api.kyberswap.com/swap/robinhood/api/v1" : "https://aggregator-api.kyberswap.com/robinhood/api/v1";
const HEADERS: Record<string, string> = KEY ? { "x-api-key": KEY } : { "X-Client-Id": "multiply-cash" };

export type KyberRoute = { routeSummary: Record<string, unknown> & { tokenIn: string; tokenOut: string; amountIn: string; amountOut: string }; routerAddress: string };

async function call<T>(path: string, body?: unknown): Promise<{ data: T | null; message: string }> {
  const r = await fetch(`${HOST}${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...HEADERS, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await r.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
  return j && j.code === 0 && j.data ? { data: j.data, message: "" } : { data: null, message: j?.message ?? `HTTP ${r.status}` };
}

/** ETH, USDG and the tokens launched here: this is a door to our own market, not an open relay */
export async function tradable(token: string): Promise<boolean> {
  const t = token.toLowerCase();
  if (t === NATIVE.toLowerCase() || t === USDG.toLowerCase()) return true;
  return (await loadRouterCoins()).some((c) => c.token.toLowerCase() === t);
}

export const kyberRoute = (tokenIn: string, tokenOut: string, amountIn: string) =>
  call<KyberRoute>(`/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`);

export const kyberBuild = (routeSummary: KyberRoute["routeSummary"], sender: string, slippageBps: number) =>
  call<{ amountOut: string; data: string; routerAddress: string; transactionValue?: string }>("/route/build", {
    routeSummary,
    sender,
    recipient: sender,
    slippageTolerance: slippageBps,
    source: "multiply-cash",
  });
