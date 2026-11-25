"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "cn";
import type { Coin } from "@/lib/types";
import { useWallet, ChainGate } from "@/components/wallet";
import { useMarkets } from "@/components/markets-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LAUNCH_ROUTER } from "@/lib/clientConfig";
import { sendGuardedTx, waitForReceipt, txErrorMessage } from "@/lib/tx";
import { ROUTER_IFACE, ROUTER_LEVERAGES, TP_MIN_PCT, TP_PRESETS, PROFIT_SPLIT_PCT, fmtNotice, maxTakeProfitPct } from "@/lib/doppler";
import { engineDiff } from "@/lib/engine";
import AssetIcon from "@/components/AssetIcon";
import AssetPicker from "@/components/launch/AssetPicker";

/**
 * The creator's controls for a managed coin: announce a new engine (market, side, leverage,
 * take-profit), or withdraw an announcement before it lands. Rendered only for the wallet that launched the coin; the
 * router enforces the same rule (and the notice) whatever the page shows.
 *
 * Nothing here moves funds. The router records the change and the time it takes effect; the
 * keeper reads it from `engineOf` and runs the position accordingly.
 */
export default function ManageEngine({ coin, delayS }: { coin: Coin; delayS: number }) {
  const router = useRouter();
  const { address, provider } = useWallet();
  const { markets, loaded } = useMarkets();
  const start = coin.pendingEngine ?? coin;
  const [market, setMarket] = useState(start.market);
  const [side, setSide] = useState(start.side);
  const [lev, setLev] = useState(start.leverage);
  const [tpPick, setTp] = useState(start.takeProfitPct);
  const [picking, setPicking] = useState(false);
  // the market it already runs on stays choosable even when new launches are sent elsewhere
  const choices = useMemo(() => markets.filter((m) => m.launchable || m.symbol === coin.market), [markets, coin.market]);
  const cap = markets.find((m) => m.symbol === market)?.maxLeverage ?? null;
  const listed = !loaded || markets.some((m) => m.symbol === market);
  const levOk = cap == null || lev <= cap;
  const tpMax = maxTakeProfitPct(lev);
  const tp = Math.min(tpPick, tpMax);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!coin.managed || !address || address.toLowerCase() !== coin.creator.toLowerCase()) return null;

  const next = { market, side, leverage: lev, takeProfitPct: tp };
  const diff = engineDiff(coin, next);
  // nothing to announce: the same as what runs, or as what is already announced
  const unchanged = diff === "no change" || (coin.pendingEngine != null && engineDiff(coin.pendingEngine, next) === "no change");
  const moves = market !== coin.market || side !== coin.side;
  const pick = (symbol: string, hint?: "long" | "short") => {
    setMarket(symbol);
    if (hint) setSide(hint);
    setPicking(false);
    const c = markets.find((m) => m.symbol === symbol)?.maxLeverage;
    if (c != null && lev > c) setLev([...ROUTER_LEVERAGES].reverse().find((l) => l <= c) ?? ROUTER_LEVERAGES[0]);
  };
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
        <span className="text-xs text-ink-3">Only you see this: you launched the token as managed</span>
      </div>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        A change is announced on-chain and takes effect {delayS > 0 ? `${fmtNotice(delayS)} later, so holders see it coming` : "right away"}.
        A new announcement replaces the one before it.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-2 text-xs font-medium text-ink-3">Market</div>
          <button
            type="button"
            aria-expanded={picking}
            onClick={() => setPicking((v) => !v)}
            className="flex h-11 w-full min-w-0 items-center gap-2.5 rounded-xl border border-line bg-panel px-3 text-left transition-colors hover:border-line-2"
          >
            <AssetIcon symbol={market} size={22} />
            <span className="min-w-0 flex-1 truncate font-semibold text-ink">{market}</span>
            <span className="shrink-0 text-sm font-medium text-brand">{picking ? "Close" : "Change"}</span>
          </button>
        </div>
        <div className="min-w-0">
          <div className="mb-2 text-xs font-medium text-ink-3">Side</div>
          <div role="radiogroup" aria-label="Side" className="grid h-11 grid-cols-2 gap-1 rounded-xl bg-panel-2 p-1">
            {(["long", "short"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={side === s}
                onClick={() => setSide(s)}
                className={cn(
                  "rounded-lg text-sm font-semibold capitalize transition-colors",
                  side === s ? cn("bg-panel shadow-sm", s === "long" ? "text-up" : "text-down") : "text-ink-3 hover:text-ink"
                )}
              >
                {s === "long" ? "↑" : "↓"} {s}
              </button>
            ))}
          </div>
        </div>
      </div>
      {picking && (
        <div className="mt-4 sm:rounded-xl sm:border sm:border-line sm:p-4">
          <AssetPicker markets={choices} loaded={loaded} value={market} onPick={pick} levCap={ROUTER_LEVERAGES[ROUTER_LEVERAGES.length - 1]} />
        </div>
      )}

      <div className="mt-5">
        <div className="mb-2 text-xs font-medium text-ink-3">Leverage{cap != null ? `, up to ${cap}x on ${market}` : ""}</div>
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

      {moves && (
        <p className="mt-5 rounded-xl bg-panel-2 px-4 py-3 text-sm leading-relaxed text-ink-2">
          When this takes effect the open {coin.market} {coin.side} is closed at market: a net profit is banked ({PROFIT_SPLIT_PCT.buyback}%
          buyback), a net loss is final. The rest opens {market} {side}.
        </p>
      )}
      {!listed && <p className="mt-3 text-sm text-down">Lighter does not list {market} right now.</p>}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <ChainGate connectLabel="Connect the creator wallet" className="w-auto">
          <Button
            size="lg"
            disabled={!!busy || unchanged || !levOk || !listed}
            className="h-auto min-h-9 py-1.5 whitespace-normal"
            onClick={() =>
              send(ROUTER_IFACE.encodeFunctionData("proposeEngine", [coin.token, market, side === "short" ? 1 : 0, lev, tp]), "Announcing")
            }
          >
            {busy === "Announcing" && <Spinner data-icon="inline-start" />}
            {busy === "Announcing" ? "Announcing" : !levOk ? `${market} allows up to ${cap}x` : unchanged ? "Nothing to announce" : `Announce: ${diff}`}
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
