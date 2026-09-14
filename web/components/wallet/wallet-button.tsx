"use client";

import { useState } from "react";
import { CHAIN } from "@/lib/clientConfig";
import { shortAddr } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ConnectDialog } from "./connect-dialog";
import { useWallet } from "./provider";

export function WalletButton() {
  const { address, status, wrongChain, disconnect, switchChain, switching } = useWallet();
  const [open, setOpen] = useState(false);

  if (status !== "connected" || !address) {
    return (
      <>
        <Button size="lg" onClick={() => setOpen(true)} disabled={status === "connecting"}>
          {/* the widest label the button can hold, so the layout is measured for it */}
          {status === "connecting" ? "Connecting" : "Connect"}
        </Button>
        <ConnectDialog open={open} onOpenChange={setOpen} />
      </>
    );
  }

  /*
   * On the wrong network the header offers the switch instead of the address.
   * Colouring the header red and leaving everything else clickable is not
   * enforcement — the fix has to be the thing the user can press.
   */
  if (wrongChain) {
    return (
      <Button size="lg" variant="destructive" onClick={switchChain} disabled={switching}>
        {switching ? "Switching" : `Switch network`}
        <span className="sr-only"> to {CHAIN.name}</span>
      </Button>
    );
  }

  return (
    <Button
      size="lg"
      variant="secondary"
      onClick={disconnect}
      title={`${address}, click to disconnect`}
      className="text-brand"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-brand" />
      <span className="num">{shortAddr(address)}</span>
    </Button>
  );
}
