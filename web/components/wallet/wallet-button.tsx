"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Copy, LogOut } from "lucide-react";
import { CHAIN, explorerAddr } from "@/lib/clientConfig";
import { shortAddr } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConnectDialog } from "./connect-dialog";
import { useWallet } from "./provider";

export function WalletButton() {
  const { address, status, wrongChain, disconnect, switchChain, switching } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="lg" variant="secondary" className="text-brand">
            <span aria-hidden className="size-1.5 rounded-full bg-brand" />
            <span className="num">{shortAddr(address)}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={10} className="w-52">
        <DropdownMenuItem
          closeOnClick={false}
          onClick={() => {
            navigator.clipboard?.writeText(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="text-brand" /> : <Copy className="text-ink-3" />}
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href={explorerAddr(address)} target="_blank" rel="noreferrer" />}>
          <ArrowUpRight className="text-ink-3" />
          View on explorer
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={disconnect}>
          <LogOut />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
