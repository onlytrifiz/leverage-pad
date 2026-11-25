import { ethers } from "ethers";
import { NATIVE } from "./clientConfig";
import { sendGuardedTx, waitForReceipt, type Eip1193Provider } from "./tx";

/** Swaps through KyberSwap from the browser: quote, build and send, always for the signer itself. */

export type Route = {
  routeSummary: Record<string, unknown> & { amountIn: string; amountOut: string };
  routerAddress: string;
};

const ERC20 = new ethers.utils.Interface(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);

export class NoRoute extends Error {}

export async function quoteRoute(tokenIn: string, tokenOut: string, amountIn: ethers.BigNumber, signal?: AbortSignal): Promise<Route> {
  const r = await fetch(`/api/swap/quote?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn.toString()}`, { signal });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    if (j?.error === "no route") throw new NoRoute("No route for this pair yet.");
    throw new Error(j?.error ?? "The quote did not answer.");
  }
  return j as Route;
}

const minusBps = (v: ethers.BigNumber, bps: number) => v.mul(10_000 - bps).div(10_000);

/**
 * Approves what is missing, takes a fresh route (they live seconds, an approval takes longer),
 * refuses one worse than what was on screen, dry-runs it and sends it. Returns the transaction hash.
 */
export async function swapRoute({
  provider,
  read,
  account,
  tokenIn,
  tokenOut,
  amountIn,
  shownOut,
  slippageBps,
  onStep,
}: {
  provider: Eip1193Provider;
  read: ethers.providers.Provider;
  account: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: ethers.BigNumber;
  /** the amount the person agreed to */
  shownOut: ethers.BigNumber;
  slippageBps: number;
  onStep: (what: "approve" | "swap") => void;
}): Promise<string> {
  let route = await quoteRoute(tokenIn, tokenOut, amountIn);
  const native = tokenIn.toLowerCase() === NATIVE.toLowerCase();
  if (!native) {
    const [allowance] = ERC20.decodeFunctionResult("allowance", await read.call({ to: tokenIn, data: ERC20.encodeFunctionData("allowance", [account, route.routerAddress]) }));
    if ((allowance as ethers.BigNumber).lt(amountIn)) {
      onStep("approve");
      // the amount of this swap and no more
      const h = await sendGuardedTx(provider, { from: account, to: tokenIn, data: ERC20.encodeFunctionData("approve", [route.routerAddress, amountIn]) });
      if ((await waitForReceipt(h)).status !== "success") throw new Error("The approval reverted.");
      const approved = route.routerAddress;
      route = await quoteRoute(tokenIn, tokenOut, amountIn);
      if (route.routerAddress.toLowerCase() !== approved.toLowerCase()) throw new Error("The router changed while approving: try again.");
    }
  }
  if (ethers.BigNumber.from(route.routeSummary.amountOut).lt(minusBps(shownOut, slippageBps))) throw new Error("The price moved past your slippage: check the new quote.");
  onStep("swap");
  const r = await fetch("/api/swap/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routeSummary: route.routeSummary, sender: account, slippageBps }),
  });
  const tx = (await r.json().catch(() => null)) as { to: string; data: string; value: string; error?: string } | null;
  if (!r.ok || !tx) throw new Error(tx?.error ?? "The swap could not be built.");
  if (tx.to.toLowerCase() !== route.routerAddress.toLowerCase()) throw new Error("The router does not match the quote.");
  // what leaves the wallet is what was typed, never more
  const value = ethers.BigNumber.from(tx.value || "0");
  if (!value.eq(native ? amountIn : 0)) throw new Error("The swap asks for a different amount.");
  const req = { from: account, to: tx.to, data: tx.data, ...(native ? { value: ethers.utils.hexValue(value) } : {}) };
  try {
    await read.call({ ...req, value: native ? value : undefined });
  } catch {
    throw new Error("The swap would revert: the price moved, try again.");
  }
  const hash = await sendGuardedTx(provider, req);
  if ((await waitForReceipt(hash)).status !== "success") throw new Error("The swap reverted, try a smaller size.");
  return hash;
}
