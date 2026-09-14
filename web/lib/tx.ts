import { CHAIN } from "./clientConfig";

/**
 * The one place this app signs anything.
 *
 * Why it exists: a wallet signs on whatever chain it happens to be pointed at.
 * A buy attaches native value and calls a router; on a chain where that address
 * holds no code the call degrades into a transfer to an address nobody controls
 * and it *succeeds* — no revert, no message, money gone. Two people lost 0.1 ETH
 * each that way on another launchpad, and nothing in the UI stopped them.
 *
 * So: no component talks to `eth_sendTransaction` directly. Everything goes
 * through `sendGuardedTx`, which re-reads the wallet's chain immediately before
 * signing and refuses if it is not ours. The UI gate in `<ChainGate>` is the
 * second layer; this one is the guarantee, and it holds even when the UI is wrong.
 */

export type Eip1193Provider = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (ev: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (ev: string, cb: (...args: unknown[]) => void) => void;
};

export class WrongChainError extends Error {
  constructor(readonly actual: number | null) {
    super(
      actual == null
        ? `Could not read the wallet's network. Nothing was sent.`
        : `Wallet is on chain ${actual}, not ${CHAIN.name} (${CHAIN.id}). Nothing was sent.`
    );
    this.name = "WrongChainError";
  }
}

export const parseChainId = (raw: unknown): number | null => {
  const n = typeof raw === "string" ? Number.parseInt(raw, 16) : Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** Reads the wallet's current chain. Never cached — the user can switch mid-flow. */
export async function readChainId(provider: Eip1193Provider): Promise<number | null> {
  try {
    return parseChainId(await provider.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

/** Throws `WrongChainError` unless the wallet is on our chain right now. */
export async function assertChain(provider: Eip1193Provider): Promise<void> {
  const actual = await readChainId(provider);
  if (actual !== CHAIN.id) throw new WrongChainError(actual);
}

/** Switch the wallet to our chain, adding it first if the wallet does not know it. */
export async function switchToChain(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN.hex }],
    });
  } catch (err) {
    // 4902: unknown chain. Some wallets nest the code inside `data`.
    const code = (err as { code?: number; data?: { originalError?: { code?: number } } })?.code;
    const nested = (err as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
    if (code !== 4902 && nested !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN.hex,
          chainName: CHAIN.name,
          nativeCurrency: CHAIN.currency,
          rpcUrls: [CHAIN.rpc],
          blockExplorerUrls: [CHAIN.explorer],
        },
      ],
    });
  }
  // Do not trust the switch: some wallets resolve the request before the user
  // has actually confirmed it.
  await assertChain(provider);
}

export type TxRequest = {
  from: string;
  to: string;
  data?: string;
  value?: string;
};

/**
 * Sends a transaction, and only ever on our chain. Returns the hash.
 * `chainId` travels in the request too — wallets are free to ignore it, which is
 * precisely why the assertion above is the part that actually protects the user.
 */
export async function sendGuardedTx(
  provider: Eip1193Provider,
  req: TxRequest
): Promise<string> {
  await assertChain(provider);
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ ...req, chainId: CHAIN.hex }],
  })) as string;
  return hash;
}

/**
 * Waits for a receipt through the public RPC rather than the wallet: a mobile
 * wallet connected over WalletConnect can drop the session the moment the user
 * switches back to the browser, and the receipt would never arrive.
 */
export async function waitForReceipt(
  hash: string,
  { timeoutMs = 120_000, pollMs = 2_000 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<{ status: "success" | "reverted" }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(CHAIN.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [hash],
      }),
    })
      .then((r) => r.json())
      .catch(() => null);
    const receipt = res?.result as { status?: string } | null | undefined;
    if (receipt) return { status: receipt.status === "0x1" ? "success" : "reverted" };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Timed out waiting for the transaction. It may still confirm.");
}

/** Wallet rejections are not failures worth a red box — say it plainly. */
export function txErrorMessage(err: unknown): string {
  const e = err as { code?: number; message?: string; shortMessage?: string };
  if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? "")) {
    return "Rejected in the wallet.";
  }
  if (err instanceof WrongChainError) return err.message;
  const raw = e?.shortMessage || e?.message || "Transaction failed.";
  return raw.length > 160 ? raw.slice(0, 157) + "…" : raw;
}
