"use client";

import type { Eip1193Provider } from "@/lib/tx";

/**
 * Connector registry.
 *
 * `injected` alone covers browser extensions and nothing else — on a phone a QR
 * code is useless and an extension does not exist, so Rainbow, Trust, Zerion and
 * MetaMask mobile are only reachable through WalletConnect's deeplinks.
 *
 * The WalletConnect provider is imported dynamically inside `connect()`, not at
 * module scope: it throws on construction when the project id is missing, and at
 * module scope that exception lands while the module is being imported — it would
 * not break the wallet button, it would break the whole app. Here a preview branch
 * without the env var simply degrades to the injected connector.
 */

export type ConnectorId = "injected" | "walletconnect";

export type Connector = {
  id: ConnectorId;
  name: string;
  /** what the user is told when it cannot be used here */
  unavailable?: string;
  connect: () => Promise<Eip1193Provider>;
};

const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

const injectedProvider = (): Eip1193Provider | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
};

export const hasInjected = () => injectedProvider() != null;
export const walletConnectConfigured = () => REOWN_PROJECT_ID.length > 0;

const injected: Connector = {
  id: "injected",
  name: "Browser wallet",
  connect: async () => {
    const p = injectedProvider();
    if (!p) throw new Error("No browser wallet found.");
    await p.request({ method: "eth_requestAccounts" });
    return p;
  },
};

const walletconnect: Connector = {
  id: "walletconnect",
  name: "Mobile wallet",
  connect: async () => {
    if (!REOWN_PROJECT_ID) throw new Error("Mobile wallets are not configured on this deployment.");
    const { CHAIN } = await import("@/lib/clientConfig");
    const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
    const provider = await EthereumProvider.init({
      projectId: REOWN_PROJECT_ID,
      chains: [CHAIN.id],
      optionalChains: [CHAIN.id],
      showQrModal: true,
      rpcMap: { [CHAIN.id]: CHAIN.rpc },
      metadata: {
        name: "multiply.cash",
        description: "Coins whose trading fees run a leveraged perp.",
        url: typeof window !== "undefined" ? window.location.origin : "https://multiply.cash",
        icons: [
          (typeof window !== "undefined" ? window.location.origin : "https://multiply.cash") +
            "/logo.png",
        ],
      },
    });
    await provider.connect();
    return provider as unknown as Eip1193Provider;
  },
};

/** Connectors offered in the dialog, in the order they should be tried. */
export function availableConnectors(): Connector[] {
  const list: Connector[] = [
    hasInjected()
      ? injected
      : { ...injected, unavailable: "No extension detected in this browser." },
  ];
  if (walletConnectConfigured()) list.push(walletconnect);
  return list;
}

export const connectorById = (id: ConnectorId): Connector =>
  id === "walletconnect" ? walletconnect : injected;
