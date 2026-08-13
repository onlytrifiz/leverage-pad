"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { CHAIN_HEX, PUBLIC_RPC, EXPLORER } from "@/lib/clientConfig";
import { shortAddr } from "@/lib/format";

/**
 * Stato wallet condiviso (nav + swap): injected provider (window.ethereum),
 * switch/add automatico di Robinhood Chain, riconnessione silenziosa al reload.
 */

type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (ev: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (ev: string, cb: (...args: unknown[]) => void) => void;
};

export const getEthereum = (): Eip1193 | null =>
  typeof window !== "undefined"
    ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null)
    : null;

export async function ensureChain(e: Eip1193) {
  const chain = (await e.request({ method: "eth_chainId" })) as string;
  if (chain.toLowerCase() === CHAIN_HEX) return;
  try {
    await e.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (sw) {
    if ((sw as { code?: number }).code === 4902) {
      await e.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CHAIN_HEX,
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [PUBLIC_RPC],
          blockExplorerUrls: [EXPLORER],
        }],
      });
    } else throw sw;
  }
}

type WalletCtx = {
  address: string | null;
  hasProvider: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
};

const Ctx = createContext<WalletCtx>({
  address: null, hasProvider: false, connecting: false, error: null,
  connect: async () => {}, disconnect: () => {},
});

export const useWallet = () => useContext(Ctx);

const RECONNECT_KEY = "lp-wallet";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [hasProvider, setHasProvider] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const e = getEthereum();
    setHasProvider(!!e);
    if (!e) return;
    // riconnessione silenziosa se l'utente si era gia' connesso
    if (localStorage.getItem(RECONNECT_KEY) === "1") {
      e.request({ method: "eth_accounts" })
        .then((accs) => {
          const a = accs as string[];
          if (a.length) setAddress(a[0]);
        })
        .catch(() => {});
    }
    const onAccounts = (...args: unknown[]) => {
      const a = args[0] as string[];
      setAddress(a.length ? a[0] : null);
      if (!a.length) localStorage.removeItem(RECONNECT_KEY);
    };
    e.on?.("accountsChanged", onAccounts);
    return () => e.removeListener?.("accountsChanged", onAccounts);
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    const e = getEthereum();
    if (!e) {
      setError("No wallet extension found — install MetaMask (or any injected wallet) to connect.");
      return;
    }
    setConnecting(true);
    try {
      const accounts = (await e.request({ method: "eth_requestAccounts" })) as string[];
      await ensureChain(e);
      setAddress(accounts[0] ?? null);
      if (accounts[0]) localStorage.setItem(RECONNECT_KEY, "1");
    } catch (err) {
      setError((err as Error).message?.slice(0, 120) || "Connection refused");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(RECONNECT_KEY);
  }, []);

  return (
    <Ctx.Provider value={{ address, hasProvider, connecting, error, connect, disconnect }}>
      {children}
    </Ctx.Provider>
  );
}

export function WalletButton() {
  const { address, connecting, connect, disconnect, error } = useWallet();
  const [showErr, setShowErr] = useState(false);

  useEffect(() => {
    if (error) {
      setShowErr(true);
      const t = setTimeout(() => setShowErr(false), 4000);
      return () => clearTimeout(t);
    }
  }, [error]);

  if (address) {
    return (
      <button
        onClick={disconnect}
        title="Disconnect"
        className="group flex items-center gap-2 rounded border border-accent/50 bg-accent-dim/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-bright transition-colors hover:border-down-bright/60 hover:text-down-bright"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent-bright group-hover:bg-down-bright" />
        <span className="num normal-case tracking-normal">{shortAddr(address)}</span>
        <span className="hidden text-[10px] group-hover:inline">×</span>
      </button>
    );
  }
  return (
    <div className="relative">
      <button
        onClick={connect}
        disabled={connecting}
        className="whitespace-nowrap rounded border border-accent/60 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-accent-bright transition-all hover:bg-accent hover:text-void hover:shadow-[0_0_20px_rgba(0,200,5,0.35)] disabled:opacity-50"
      >
        {connecting ? "connecting…" : "connect wallet"}
      </button>
      {showErr && error && (
        <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded border border-down/50 bg-panel-2 px-3 py-2 text-[11px] normal-case text-down-bright">
          {error}
        </div>
      )}
    </div>
  );
}
