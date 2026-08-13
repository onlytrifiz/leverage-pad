"use client";

import { useEffect, useMemo, useState } from "react";
import type { MarketRow } from "@/lib/lighter";
import { useWallet } from "./wallet";
import AssetIcon from "./AssetIcon";

/**
 * Configuratore di lancio: direzione → sottostante → leva → identita'.
 * L'anteprima a destra mostra cosa fara' il motore della coin. Il deploy vero
 * gira dalla macchina operatore (serve la chiave del deployer): qui si genera
 * il comando esatto, con copy — nessuna chiave passa mai dal browser.
 */

const LEVERAGES = [2, 3, 5, 10, 20];

const RISK_PROFILES = [
  { key: "safe", label: "safe", trigger: 20, desc: "every tranche banks fully at +20% — small wins, constant burns" },
  { key: "balanced", label: "balanced", trigger: 50, desc: "every tranche banks fully at +50% — the middle path" },
  { key: "degen", label: "degen", trigger: 100, desc: "every tranche rides to +100% before banking — maximum conviction" },
] as const;
type RiskKey = (typeof RISK_PROFILES)[number]["key"];

const dirCurve = (up: boolean) => (
  <svg viewBox="0 0 64 24" className="h-6 w-16" aria-hidden>
    <path
      d={up ? "M2 20 C 22 20, 34 14, 46 8 S 60 4, 62 3" : "M2 3 C 22 4, 34 10, 46 16 S 60 20, 62 21"}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

export default function LaunchForm() {
  const { address } = useWallet();
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [side, setSide] = useState<"long" | "short">("long");
  const [market, setMarket] = useState("NVDA");
  const [lev, setLev] = useState(3);
  const [risk, setRisk] = useState<RiskKey>("balanced");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [assetQ, setAssetQ] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/markets")
      .then((r) => r.json())
      .then((j) => setMarkets(j.markets ?? []))
      .catch(() => {});
  }, []);

  const selected = markets.find((m) => m.symbol === market) ?? null;
  const filteredMarkets = useMemo(() => {
    const q = assetQ.trim().toLowerCase();
    return q ? markets.filter((m) => m.symbol.toLowerCase().includes(q)) : markets;
  }, [markets, assetQ]);

  const cmd = useMemo(() => {
    const parts = [
      "node launchCoin.js",
      `--name "${name || "My Coin"}"`,
      `--symbol ${(symbol || "COIN").toUpperCase()}`,
      `--market ${market}`,
      `--side ${side}`,
      `--lev ${lev}`,
      `--risk ${risk}`,
    ];
    if (address) parts.push(`--creator ${address}`);
    return parts.join(" ");
  }, [name, symbol, market, side, lev, risk, address]);

  const gainExample = (10 * lev).toFixed(0);

  return (
    <div className="pt-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        {/* ── colonna form ─────────────────────────────────────────────────── */}
        <div className="min-w-0">
          <div className="lbl mb-2">new coin</div>
          <h1 className="text-[26px] font-bold tracking-tight">Launch a coin</h1>
          <p className="mt-2 max-w-[520px] text-[13px] leading-relaxed text-ink-2">
            Pick a direction, choose the underlying perp, set the leverage, name it.
            The liquidity locks forever at launch — after that, the engine runs itself.
          </p>

          {/* step 1 — direzione */}
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-accent/60 text-[10px] font-bold text-accent-bright">1</span>
              <span className="text-[13px] font-semibold">Choose the direction</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(["long", "short"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={`panel flex items-start justify-between gap-3 px-4 py-4 text-left transition-all ${
                    side === s
                      ? "border-accent/60 shadow-[0_0_24px_rgba(0,200,5,0.10)]"
                      : "opacity-70 hover:opacity-100"
                  }`}
                >
                  <span>
                    <span className={`text-[15px] font-bold uppercase tracking-[0.1em] ${s === "long" ? "text-up-bright" : "text-down-bright"}`}>
                      {s}
                    </span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-ink-3">
                      {s === "long" ? "The engine profits when the underlying rises." : "The engine profits when the underlying falls."}
                    </span>
                  </span>
                  <span className={s === "long" ? "text-up-bright" : "text-down-bright"}>{dirCurve(s === "long")}</span>
                </button>
              ))}
            </div>
          </div>

          {/* step 2 — sottostante */}
          <div className="mt-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-accent/60 text-[10px] font-bold text-accent-bright">2</span>
                <span className="text-[13px] font-semibold">Pick the underlying</span>
                <span className="lbl">39 lighter perps</span>
              </div>
              <input
                value={assetQ}
                onChange={(e) => setAssetQ(e.target.value)}
                placeholder="filter…"
                className="w-32 rounded border border-line bg-panel px-2.5 py-1 text-[11px] text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
              />
            </div>
            <div className="grid max-h-[320px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
              {markets.length === 0 && <div className="lbl col-span-3 py-6">loading markets…</div>}
              {filteredMarkets.map((m) => (
                <button
                  key={m.marketId}
                  onClick={() => setMarket(m.symbol)}
                  className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-left transition-all ${
                    market === m.symbol
                      ? "border-accent/60 bg-accent-dim/30"
                      : "border-line bg-panel hover:border-line-2"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <AssetIcon symbol={m.symbol} size={20} />
                    <span className="truncate text-[12px] font-semibold">{m.symbol}</span>
                  </span>
                  {m.change24h != null && (
                    <span className={`num text-[10px] ${m.change24h >= 0 ? "text-up-bright" : "text-down-bright"}`}>
                      {m.change24h >= 0 ? "+" : ""}{m.change24h.toFixed(1)}%
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* step 3 — leva */}
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-accent/60 text-[10px] font-bold text-accent-bright">3</span>
              <span className="text-[13px] font-semibold">Set the leverage</span>
              <span className="lbl">isolated margin</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {LEVERAGES.map((l) => (
                <button
                  key={l}
                  onClick={() => setLev(l)}
                  className={`rounded-md border px-5 py-2.5 text-[14px] font-bold transition-all ${
                    lev === l
                      ? "border-accent/60 bg-accent-dim/30 text-accent-bright"
                      : "border-line bg-panel text-ink-2 hover:border-line-2"
                  }`}
                >
                  {l}×
                </button>
              ))}
            </div>
            <div className="lbl mt-2 normal-case tracking-normal">
              higher leverage = faster burns on a good call, faster liquidation on a bad one
            </div>
          </div>

          {/* step 4 — profilo di rischio */}
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-accent/60 text-[10px] font-bold text-accent-bright">4</span>
              <span className="text-[13px] font-semibold">Choose the risk profile</span>
              <span className="lbl">when the engine takes profit</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {RISK_PROFILES.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setRisk(p.key)}
                  className={`panel px-4 py-3.5 text-left transition-all ${
                    risk === p.key
                      ? "border-accent/60 shadow-[0_0_24px_rgba(0,200,5,0.10)]"
                      : "opacity-70 hover:opacity-100"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-[13px] font-bold uppercase tracking-[0.1em] ${p.key === "degen" ? "text-down-bright" : p.key === "safe" ? "text-up-bright" : "text-accent-bright"}`}>
                      {p.label}
                    </span>
                    <span className="num text-[11px] text-ink-2">banks at +{p.trigger}%</span>
                  </div>
                  <div className="mt-1.5 text-[11px] leading-relaxed text-ink-3">{p.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* step 5 — identita' */}
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-accent/60 text-[10px] font-bold text-accent-bright">5</span>
              <span className="text-[13px] font-semibold">Name it</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Coin name"
                className="rounded-md border border-line bg-panel px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
              />
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10))}
                placeholder="TICKER"
                className="rounded-md border border-line bg-panel px-3 py-2.5 text-[13px] uppercase text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
              />
            </div>
          </div>

          {/* comando di lancio */}
          <div className="panel mt-8">
            <div className="panel-head">
              <span className="lbl">launch command</span>
              <span className="lbl">runs on the operator machine</span>
            </div>
            <div className="p-4">
              <div className="flex items-start justify-between gap-3 rounded-md border border-line bg-void px-3 py-3">
                <code className="num min-w-0 break-all text-[12px] leading-relaxed text-accent-bright">{cmd}</code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(cmd).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                  className="shrink-0 rounded border border-line px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-2 transition-colors hover:border-accent/50 hover:text-accent-bright"
                >
                  {copied ? "copied ✓" : "copy"}
                </button>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                Launching deploys the token, seeds the pool one-sided and locks the LP NFT
                forever — it needs the deployer key, so it runs from the operator machine,
                never from the browser. Add <span className="text-ink-2">--dry</span> first to
                preview the plan without sending anything. The lock is irreversible.
              </p>
            </div>
          </div>
        </div>

        {/* ── colonna anteprima ────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="panel">
            <div className="panel-head">
              <span className="lbl">live preview</span>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-md border border-accent/40 bg-accent-dim/30 text-[16px] font-bold text-accent-bright">
                  {(symbol || "?")[0]}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-bold">${symbol || "TICKER"}</div>
                  <div className="truncate text-[11px] text-ink-3">{name || "Your coin"}</div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line/50 sm:grid-cols-4">
                {[
                  { label: "leverage", value: `${lev}×` },
                  { label: "underlying", value: market },
                  { label: "direction", value: side },
                  { label: "risk", value: risk },
                ].map((c) => (
                  <div key={c.label} className="bg-panel-2 px-3 py-2.5 text-center">
                    <div className={`text-[13px] font-bold uppercase ${c.label === "direction" ? (side === "long" ? "text-up-bright" : "text-down-bright") : "text-ink"}`}>
                      {c.value}
                    </div>
                    <div className="lbl mt-0.5">{c.label}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-md border border-line bg-void px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[12px] font-semibold">
                    <AssetIcon symbol={market} size={18} />
                    {market} / USD
                  </span>
                  {selected?.change24h != null && (
                    <span className={`num rounded px-1.5 py-0.5 text-[11px] ${selected.change24h >= 0 ? "bg-up/15 text-up-bright" : "bg-down/15 text-down-bright"}`}>
                      {selected.change24h >= 0 ? "+" : ""}{selected.change24h.toFixed(2)}% 24h
                    </span>
                  )}
                </div>
                <div className="num mt-2 text-[22px] font-bold">
                  {selected?.mark != null
                    ? `$${selected.mark >= 100 ? selected.mark.toLocaleString("en-US", { maximumFractionDigits: 0 }) : selected.mark.toPrecision(5)}`
                    : "—"}
                </div>
                <div className="lbl mt-1 normal-case tracking-normal">
                  mark price on lighter · the engine trades this at {lev}×
                </div>
              </div>

              <div className="mt-4 rounded-md border border-accent/30 bg-accent-dim/20 px-3 py-3 text-[11px] leading-relaxed text-ink-2">
                <span className="font-semibold text-accent-bright">
                  {market} {lev}× {side} · {risk}
                </span>{" "}
                — if {market} moves {side === "long" ? "up" : "down"} 10%, the coin&apos;s perp
                treasury gains ~{gainExample}%. Each deposit is its own tranche that banks
                fully at +{RISK_PROFILES.find((p) => p.key === risk)!.trigger}%; realized
                profits flow back on-chain — 75% buys and burns the coin, 25% to treasury.
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="lbl">how it works</span>
            </div>
            <ol className="space-y-3 p-4">
              {[
                "Token deploys with 1B fixed supply, no owner — all of it seeded one-sided into a Uniswap V3 pool at ~$4k mcap.",
                "The LP NFT locks forever in a contract with no owner and no withdraw. Nobody can rug it.",
                "Every swap pays 1% — all of it funds the perp treasury. The protocol earns only 25% of realized profits.",
                `At $20 the engine opens the ${lev}× ${side} on ${market}; profits are withdrawn per your risk profile, bought back and burned.`,
              ].map((step, i) => (
                <li key={i} className="flex gap-3 text-[11px] leading-relaxed text-ink-2">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line-2 text-[9px] font-bold text-ink-3">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
