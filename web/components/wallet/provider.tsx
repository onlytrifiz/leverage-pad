"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { CHAIN } from "@/lib/clientConfig";
import {
  parseChainId,
  readChainId,
  switchToChain,
  txErrorMessage,
  type Eip1193Provider,
} from "@/lib/tx";
import { connectorById, hasInjected, type ConnectorId } from "./connectors";

/**
 * Shared wallet state.
 *
 * The chain id is part of the state and is kept live through `chainChanged`.
 * The previous version did not track it at all, so every signing control
 * rendered identically no matter which network the wallet was pointed at, and
 * the user found out only by meeting a raw error after clicking.
 */

type Status = "disconnected" | "connecting" | "connected";

type WalletCtx = {
  address: string | null;
  chainId: number | null;
  status: Status;
  error: string | null;
  provider: Eip1193Provider | null;
  /** connected, but pointed at some other network */
  wrongChain: boolean;
  connect: (id: ConnectorId) => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  switching: boolean;
  clearError: () => void;
};

const Ctx = createContext<WalletCtx | null>(null);

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

const LAST_CONNECTOR_KEY = "multiply.wallet.connector";

const readStored = (): ConnectorId | null => {
  try {
    const v = localStorage.getItem(LAST_CONNECTOR_KEY);
    return v === "injected" || v === "walletconnect" ? v : null;
  } catch {
    return null;
  }
};

const remember = (id: ConnectorId | null) => {
  try {
    if (id) localStorage.setItem(LAST_CONNECTOR_KEY, id);
    else localStorage.removeItem(LAST_CONNECTOR_KEY);
  } catch {
    /* private browsing: the session simply does not survive a reload */
  }
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const disconnect = useCallback(() => {
    setProvider(null);
    setAddress(null);
    setChainId(null);
    setStatus("disconnected");
    setError(null);
    remember(null);
  }, []);

  /**
   * Subscriptions live in an effect keyed on the provider, so React owns the
   * teardown: swapping connectors or disconnecting can never leave a listener
   * from a dead session writing into current state.
   */
  useEffect(() => {
    if (!provider) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      if (!accounts?.length) disconnect();
      else setAddress(accounts[0]);
    };
    const onChain = (...args: unknown[]) => setChainId(parseChainId(args[0]));
    const onDisconnect = () => disconnect();

    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    provider.on?.("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [provider, disconnect]);

  const adopt = useCallback(async (p: Eip1193Provider, id: ConnectorId) => {
    const accounts = (await p.request({ method: "eth_accounts" })) as string[];
    if (!accounts?.length) throw new Error("The wallet returned no account.");
    setProvider(p);
    setAddress(accounts[0]);
    setChainId(await readChainId(p));
    setStatus("connected");
    remember(id);
  }, []);

  const connect = useCallback(
    async (id: ConnectorId) => {
      setError(null);
      setStatus("connecting");
      try {
        await adopt(await connectorById(id).connect(), id);
      } catch (err) {
        setStatus("disconnected");
        setError(txErrorMessage(err));
      }
    },
    [adopt]
  );

  /**
   * Silent reconnect on reload, injected only: `eth_accounts` does not prompt,
   * so it is safe to ask unattended. WalletConnect is left out on purpose —
   * restoring its session can throw the wallet app open over a page the user
   * only meant to read.
   */
  useEffect(() => {
    if (readStored() !== "injected" || !hasInjected()) return;
    const p = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!p) return;
    let cancelled = false;
    p.request({ method: "eth_accounts" })
      .then(async (accs) => {
        if (cancelled || !(accs as string[])?.length) return;
        await adopt(p, "injected");
      })
      .catch(() => {
        /* locked wallet: stay disconnected, the button still works */
      });
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  const switchChain = useCallback(async () => {
    if (!provider) return;
    setSwitching(true);
    setError(null);
    try {
      await switchToChain(provider);
      setChainId(await readChainId(provider));
    } catch (err) {
      setError(txErrorMessage(err));
    } finally {
      setSwitching(false);
    }
  }, [provider]);

  const value = useMemo<WalletCtx>(
    () => ({
      address,
      chainId,
      status,
      error,
      provider,
      wrongChain: status === "connected" && chainId !== CHAIN.id,
      connect,
      disconnect,
      switchChain,
      switching,
      clearError: () => setError(null),
    }),
    [address, chainId, status, error, provider, connect, disconnect, switchChain, switching]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
