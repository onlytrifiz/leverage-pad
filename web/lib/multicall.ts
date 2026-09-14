import { ethers } from "ethers";
import { MULTICALL3 } from "./clientConfig";

/**
 * Batched reads through Multicall3.
 *
 * The market list used to fire two `eth_call`s per coin and the detail page
 * four, in separate round trips, on a page that refreshes every 30 seconds —
 * against a public RPC that rate-limits. One request now carries the lot.
 *
 * `aggregate3` with `allowFailure: true` is deliberate: a single unreadable
 * pool must not blank the other nine rows, so failures come back per call and
 * the caller decides what a missing value means.
 */

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];

export type Call = {
  target: string;
  iface: ethers.utils.Interface;
  fn: string;
  args?: readonly unknown[];
};

/**
 * Returns one entry per call, in order: the decoded result, or `null` if that
 * particular call reverted or could not be decoded.
 */
export async function multicall(
  provider: ethers.providers.Provider,
  calls: Call[]
): Promise<(ethers.utils.Result | null)[]> {
  if (calls.length === 0) return [];
  const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const payload = calls.map((c) => ({
    target: c.target,
    allowFailure: true,
    callData: c.iface.encodeFunctionData(c.fn, c.args ? [...c.args] : []),
  }));
  /*
   * Batching turned N independent reads into one, which also turned N partial
   * failures into one total failure: a single rate-limited response and the
   * whole page shows dashes. The public RPC throttles under bursts, so one
   * short retry buys back the resilience the per-coin calls used to have.
   */
  let results: { success: boolean; returnData: string }[] | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && results == null; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
    try {
      results = await mc.callStatic.aggregate3(payload);
    } catch (e) {
      lastErr = e;
    }
  }
  if (results == null) throw lastErr;
  return results.map((r, i) => {
    if (!r.success || r.returnData === "0x") return null;
    try {
      return calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData);
    } catch {
      return null;
    }
  });
}

/**
 * Small helper for the common shape: a fixed number of calls per item.
 * Returns the results grouped back per item, so callers never index by hand
 * into a flat array — the off-by-one there is silent and reads as bad data.
 */
export async function multicallPerItem<T>(
  provider: ethers.providers.Provider,
  items: T[],
  callsFor: (item: T) => Call[]
): Promise<(ethers.utils.Result | null)[][]> {
  const groups = items.map(callsFor);
  const flat = await multicall(
    provider,
    groups.flat()
  );
  const out: (ethers.utils.Result | null)[][] = [];
  let cursor = 0;
  for (const g of groups) {
    out.push(flat.slice(cursor, cursor + g.length));
    cursor += g.length;
  }
  return out;
}
