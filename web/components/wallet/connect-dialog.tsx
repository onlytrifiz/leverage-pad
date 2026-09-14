"use client";

import { Wallet, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { availableConnectors, type ConnectorId } from "./connectors";
import { useWallet } from "./provider";

const ICON: Record<ConnectorId, typeof Wallet> = {
  injected: Wallet,
  walletconnect: Smartphone,
};

const HINT: Record<ConnectorId, string> = {
  injected: "MetaMask, Rabby, Brave and other extensions.",
  walletconnect: "Rainbow, Trust, Zerion, MetaMask mobile. Opens the app.",
};

export function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { connect, status, error } = useWallet();
  /*
   * Recomputed on every render, deliberately not memoised on mount: several
   * extensions inject `window.ethereum` after the page has loaded, and a list
   * captured at mount marked them permanently absent — the dialog offered a
   * disabled "no extension detected" row to people who had one installed.
   * The dialog re-renders when it opens, which is the moment that matters.
   */
  const connectors = availableConnectors();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Connect a wallet</DialogTitle>
          <DialogDescription>
            Trading happens on {"Robinhood Chain"}. Connecting only shares your address.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {connectors.map((c) => {
            const Icon = ICON[c.id];
            return (
              <button
                key={c.id}
                type="button"
                disabled={!!c.unavailable || status === "connecting"}
                onClick={async () => {
                  await connect(c.id);
                  onOpenChange(false);
                }}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-line-2 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <Icon className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-md font-semibold text-ink">{c.name}</span>
                  <span className="block text-xs text-ink-3">{c.unavailable ?? HINT[c.id]}</span>
                </span>
                {status === "connecting" && <Spinner className="text-ink-3" />}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-xs leading-relaxed text-down" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Opens the dialog. Used anywhere the next step is "have a wallet". */
export function ConnectButton({
  label = "Connect wallet",
  size = "default",
  className,
  onOpen,
}: {
  label?: string;
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  onOpen: () => void;
}) {
  const { status } = useWallet();
  return (
    <Button size={size} className={className} onClick={onOpen} disabled={status === "connecting"}>
      {status === "connecting" ? "Connecting" : label}
    </Button>
  );
}
