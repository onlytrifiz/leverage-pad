"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import type { Coin } from "@/lib/types";
import { useWallet, ChainGate } from "@/components/wallet";
import { useMarkets } from "@/components/markets-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LAUNCH_ROUTER } from "@/lib/clientConfig";
import { sendGuardedTx, waitForReceipt, txErrorMessage } from "@/lib/tx";
import { ROUTER_IFACE, ROUTER_LEVERAGES, TP_MIN_PCT, TP_PRESETS, MANAGED_DELAY_HOURS, maxTakeProfitPct } from "@/lib/doppler";

/**
 * The creator's controls for a managed coin: announce new leverage and take-profit, or withdraw
 * an announcement before it lands. Rendered only for the wallet that launched the coin; the
 * router enforces the same rule (and the notice) whatever the page shows.
 *
 * Nothing here moves funds. The router records the change and the time it takes effect; the
 * keeper reads it from `engineOf` and runs the position accordingly.
 */
export default function ManageEngine({ coin }: { coin: Coin }) {
  const router = useRouter();
  const { address, provider } = useWallet();
  const { markets } = useMarkets();
  const cap = markets.find((m) => m.symbol === coin.market)?.maxLeverage ?? null;
  const [lev, setLev] = useState(coin.pendingEngine?.leverage ?? coin.leverage);
  const [tpPick, setTp] = useState(coin.pendingEngine?.takeProfitPct ?? coin.takeProfitPct);
  const tpMax = maxTakeProfitPct(lev);
  const tp = Math.min(tpPick, tpMax);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!coin.managed || !address || address.toLowerCase() !== coin.creator.toLowerCase()) return null;

  const unchanged = lev === coin.leverage && tp === coin.takeProfitPct;
  const send = async (data: string, label: string) => {
    if (!provider || !address) return;
    setError(null);
    setBusy(label);
    try {
      const hash = await sendGuardedTx(provider, { from: address, to: LAUNCH_ROUTER, data });
      const rc = await waitForReceipt(hash);
      if (rc.status !== "success") throw new Error("The transaction reverted.");
      router.refresh();
    } catch (e) {
      setError(txErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-[18px] border border-brand/40 bg-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">Manage the engine</h2>
        <span className="text-xs text-ink-3">Only you see this: you launched the coin as managed</span>
      </div>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        A change is announced on-chain and takes effect {MANAGED_DELAY_HOURS} hours later, so holders see it coming. Market and
        side are fixed forever.
      </p>

      <div className="mt-5">
        <div className="mb-2 text-xs font-medium text-ink-3">Leverage{cap != null ? `, up to ${cap}x on ${coin.market}` : ""}</div>
        <div className="flex flex-wrap gap-1.5">
          {ROUTER_LEVERAGES.map((l) => {
            const off = cap != null && l > cap;
            return (
              <button
                key={l}
                type="button"
                disabled={off}
                onClick={() => setLev(l)}
                className={cn(
                  "num h-8 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                  lev === l ? "border-brand bg-brand text-white" : "border-line bg-panel text-ink-2 hover:border-line-2"
                )}
              >
                {l}x
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5">
        <label className="mb-2 flex items-baseline justify-between text-xs font-medium text-ink-3" htmlFor="manage-tp">
          <span>Take-profit per deposit</span>
          <span className="num text-lg font-semibold text-ink">+{tp}%</span>
        </label>
        <input
          id="manage-tp"
          type="range"
          min={TP_MIN_PCT}
          max={tpMax}
          step={5}
          value={tp}
          onChange={(e) => setTp(Number(e.target.value))}
          className="range-brand w-full"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TP_PRESETS.map((p) => (
            <button
              key={p.pct}
              type="button"
              disabled={p.pct > tpMax}
              onClick={() => setTp(p.pct)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                tp === p.pct ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-2 hover:border-line-2"
              )}
            >
              +{p.pct}% {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <ChainGate connectLabel="Connect the creator wallet" className="w-auto">
          <Button
            size="lg"
            disabled={!!busy || unchanged}
            onClick={() => send(ROUTER_IFACE.encodeFunctionData("proposeEngine", [coin.token, lev, tp]), "Announcing")}
          >
            {busy === "Announcing" && <Spinner data-icon="inline-start" />}
            {busy === "Announcing" ? "Announcing" : `Announce: ${lev}x, +${tp}%`}
          </Button>
        </ChainGate>
        {coin.pendingEngine && (
          <Button
            size="lg"
            variant="outline"
            disabled={!!busy}
            onClick={() => send(ROUTER_IFACE.encodeFunctionData("cancelEngineProposal", [coin.token]), "Withdrawing")}
          >
            {busy === "Withdrawing" ? "Withdrawing" : "Withdraw the announcement"}
          </Button>
        )}
      </div>
      {error && (
        <p className="mt-3 text-sm text-down" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
