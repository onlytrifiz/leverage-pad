"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CHAIN } from "@/lib/clientConfig";
import { ConnectDialog } from "./connect-dialog";
import { useWallet } from "./provider";

/**
 * The second layer of chain enforcement, in the UI.
 *
 * An action that would sign is not rendered at all while the wallet is on
 * another network — in its place goes the remedy, a button that switches. Not a
 * warning, and certainly not a red header with every signing control still live
 * underneath it. `sendGuardedTx` is the guarantee behind this; this is the part
 * that means the user never has to meet it.
 */
export function ChainGate({
  children,
  connectLabel = "Connect wallet",
  size = "xl",
  className = "w-full",
}: {
  children: React.ReactNode;
  connectLabel?: string;
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const { status, wrongChain, switchChain, switching } = useWallet();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (status !== "connected") {
    return (
      <>
        <Button
          size={size}
          className={className}
          onClick={() => setDialogOpen(true)}
          disabled={status === "connecting"}
        >
          {status === "connecting" ? "Connecting" : connectLabel}
        </Button>
        <ConnectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    );
  }

  if (wrongChain) {
    return (
      <div className={className}>
        <Button size={size} className="w-full" onClick={switchChain} disabled={switching}>
          {switching ? <Spinner data-icon="inline-start" /> : null}
          Switch to {CHAIN.name}
        </Button>
        <p className="mt-2 text-xs leading-relaxed text-ink-3">
          Your wallet is on another network. Trading is only possible on {CHAIN.name}.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
