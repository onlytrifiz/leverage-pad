"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useWallet, ChainGate } from "@/components/wallet";
import { useMarkets } from "./markets-provider";
import AssetIcon from "./AssetIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelHeader, PanelTitle, PanelMeta, PanelBody } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { OptionCard, OptionGroup, StepHeading } from "@/components/ui/option-card";
import { CoinSeal } from "@/components/brand/CoinSeal";
import { OPEN_GATE_LABEL } from "@/lib/thresholds";
import { fmtChange } from "@/lib/format";
import { USDG, LAUNCH_FEE_HUB, LAUNCH_ROUTER, explorerTx, explorerToken, explorerAddr } from "@/lib/clientConfig";
import { multicall } from "@/lib/multicall";
import { sendGuardedTx, waitForReceipt, txErrorMessage } from "@/lib/tx";
import {
  FEE_PRESETS,
  SNIPE,
  firstBuyDopplerCostPct,
  HOOK_FLUSH_EPSILON_USDG,
  ERC20_IFACE,
  buildCreateParams,
  simulateBundle,
  simulateRouterLaunch,
  encodeRouterLaunch,
  routerSalt,
  readProtocolOwner,
  metadataSignMessage,
  type RouterInput,
  launchTicks,
  randomSalt,
  readProvider,
  dexscreenerPool,
  type EngineParams,
} from "@/lib/doppler";
import { AnimatedNumber, Reveal, RevealItem } from "@/components/motion";
import { Gauge } from "@/components/animate-ui/icons/gauge";
import { Sparkles } from "@/components/animate-ui/icons/sparkles";
import { ChartColumnIncreasing } from "@/components/animate-ui/icons/chart-column-increasing";
import { ChartColumnDecreasing } from "@/components/animate-ui/icons/chart-column-decreasing";
import { motion } from "motion/react";

/**
 * Launch configurator: direction → underlying → leverage → risk → fee →
 * protection → identity, then the launch itself, signed by the connected
 * wallet. The deploy goes through the multiply launch router, which builds the
 * Doppler launch on-chain from these inputs; see `lib/doppler.ts` for the
 * mirror encoders used to predict the token address before signing.
 */

const LEVERAGES = [2, 3, 5, 10, 20];

const RISK_PROFILES = [
  { key: "safe", label: "safe", trigger: 20, desc: "Every tranche banks fully at +20%: small wins, constant burns." },
  { key: "balanced", label: "balanced", trigger: 50, desc: "Every tranche banks fully at +50%. The middle path." },
  { key: "degen", label: "degen", trigger: 100, desc: "Every tranche rides to +100% before banking. Maximum conviction." },
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

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtUsdg = (v: ethers.BigNumber) =>
  Number(ethers.utils.formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });

type Launched = { asset: string; poolId: string; hash: string; symbol: string; tokenURI: string; metadataUrl: string };

/**
 * Pins seal + metadata to IPFS; the returned ipfs:// URI becomes the token's URI on-chain.
 * The wallet signs the payload first (EIP-191, no gas): the endpoint pins only for the wallet
 * that will launch, so nobody can fill the project's pinning quota or spoof a creator.
 */
async function pinMetadata(
  provider: NonNullable<ReturnType<typeof useWallet>["provider"]>,
  input: { name: string; symbol: string; creator: string; engine: EngineParams }
) {
  const ts = Math.floor(Date.now() / 1000);
  const message = metadataSignMessage({ ...input, ts });
  const signature = (await provider.request({
    method: "personal_sign",
    params: [ethers.utils.hexlify(ethers.utils.toUtf8Bytes(message)), input.creator],
  })) as string;
  const res = await fetch("/api/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, ts, signature }),
  });
  const json = (await res.json()) as { tokenURI?: string; gatewayUrl?: string; error?: string };
  if (!res.ok || !json.tokenURI) throw new Error(json.error ?? "Could not pin the metadata.");
  return { tokenURI: json.tokenURI, metadataUrl: json.gatewayUrl ?? `https://ipfs.io/ipfs/${json.tokenURI.replace("ipfs://", "")}` };
}

/** USDG has 6 decimals: anything finer would make parseUnits throw and silently drop the first buy. */
const clampUsdgInput = (v: string) => {
  const cleaned = v.replace(/[^0-9.]/g, "");
  const [i, d] = cleaned.split(".");
  return d === undefined ? i : `${i}.${d.slice(0, 6)}`;
};

export default function LaunchForm() {
  const { address, provider } = useWallet();
  const { markets, loaded } = useMarkets();
  const [side, setSide] = useState<"long" | "short">("long");
  const [market, setMarket] = useState("NVDA");
  const [lev, setLev] = useState(3);
  const [risk, setRisk] = useState<RiskKey>("balanced");
  const [feeBps, setFeeBps] = useState<number>(300);
  const [antiSnipe, setAntiSnipe] = useState(false);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [firstBuy, setFirstBuy] = useState("");
  const [assetQ, setAssetQ] = useState("");
  const [salt, setSalt] = useState<string>(() => randomSalt());

  const [predicted, setPredicted] = useState<{ asset: string; gas: ethers.BigNumber | null; firstBuyOut: ethers.BigNumber | null } | null>(null);
  const [protocolOwner, setProtocolOwner] = useState<string | undefined>(undefined);
  const [simError, setSimError] = useState<string | null>(null);
  const [acct, setAcct] = useState<{ usdg: ethers.BigNumber; allowance: ethers.BigNumber } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Launched | null>(null);

  const selected = markets.find((m) => m.symbol === market) ?? null;
  const filteredMarkets = useMemo(() => {
    const q = assetQ.trim().toLowerCase();
    return q ? markets.filter((m) => m.symbol.toLowerCase().includes(q)) : markets;
  }, [markets, assetQ]);
  const trigger = RISK_PROFILES.find((p) => p.key === risk)!.trigger;
  const feeLabel = FEE_PRESETS.find((f) => f.bps === feeBps)!.label;
  const { mcapUsd } = launchTicks();

  const engine: EngineParams = useMemo(
    () => ({ market, side, leverage: lev, risk }),
    [market, side, lev, risk]
  );
  const firstBuyIn = useMemo(() => {
    if (!firstBuy || Number(firstBuy) <= 0) return ethers.constants.Zero;
    try {
      return ethers.utils.parseUnits(firstBuy, 6);
    } catch {
      return ethers.constants.Zero;
    }
  }, [firstBuy]);
  const withFirstBuy = !firstBuyIn.isZero();
  const ready = name.trim().length > 0 && symbol.length > 0;

  const routerInput = useMemo<RouterInput | null>(() => {
    if (!address || !ready) return null;
    return { name: name.trim(), symbol, tokenURI: "", fee: feeBps * 100, antiSnipe, mcap: 0, firstBuy: firstBuyIn, salt };
  }, [address, ready, name, symbol, feeBps, antiSnipe, firstBuyIn, salt]);
  /** mirror of what the router builds, for the bundle simulator before the USDG approval */
  const params = useMemo(() => {
    if (!address || !ready) return null;
    return buildCreateParams({
      name: name.trim(),
      symbol,
      engine,
      creator: address,
      protocolOwner,
      feeBps,
      antiSnipe,
      salt: routerSalt(address, salt),
    });
  }, [address, ready, name, symbol, engine, protocolOwner, feeBps, antiSnipe, salt]);

  useEffect(() => {
    let live = true;
    readProtocolOwner().then((o) => {
      if (live) setProtocolOwner(o);
    });
    return () => {
      live = false;
    };
  }, []);

  /** balances and the Bundler allowance in one request */
  const refresh = useCallback(async (addr: string) => {
    const [b, a] = await multicall(readProvider, [
      { target: USDG, iface: ERC20_IFACE, fn: "balanceOf", args: [addr] },
      { target: USDG, iface: ERC20_IFACE, fn: "allowance", args: [addr, LAUNCH_ROUTER] },
    ]);
    setAcct({ usdg: b ? b[0] : ethers.constants.Zero, allowance: a ? a[0] : ethers.constants.Zero });
  }, []);

  useEffect(() => {
    if (!address) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh(address).catch(() => {});
  }, [address, refresh]);

  /*
   * Dry-run on every change, debounced: the token address depends on the salt
   * alone, so what this shows is the address the launch will produce, and a
   * revert here is a revert the wallet would have shown after signing.
   */
  useEffect(() => {
    if (!address || !params || !routerInput) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPredicted(null);
      setSimError(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const approved = !withFirstBuy || (acct?.allowance.gte(firstBuyIn) ?? false);
        // the router dry-run is exact; before the USDG approval the first-buy path cannot pull
        // funds in eth_call, so the Bundler simulator (payer = 0) stands in with the same params
        const sim = approved
          ? await simulateRouterLaunch(address, routerInput)
          : { ...(await simulateBundle(address, params, firstBuyIn)), poolId: null };
        let gas: ethers.BigNumber | null = null;
        if (approved) {
          try {
            gas = await readProvider.estimateGas({ from: address, to: LAUNCH_ROUTER, data: encodeRouterLaunch(routerInput) });
          } catch {
            gas = null;
          }
        }
        if (live) {
          setPredicted({ asset: sim.asset, gas, firstBuyOut: withFirstBuy ? ("amountOut" in sim ? sim.amountOut : sim.firstBuyOut) : null });
          setSimError(null);
        }
      } catch (e) {
        if (live) {
          setPredicted(null);
          setSimError(txErrorMessage(e));
        }
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [address, params, routerInput, withFirstBuy, firstBuyIn, acct]);

  const insufficient = !!(withFirstBuy && acct && firstBuyIn.gt(acct.usdg));
  const needsApproval = !!(withFirstBuy && acct && acct.allowance.lt(firstBuyIn));

  async function launch() {
    if (!routerInput || !address || !provider) return;
    setError(null);
    try {
      if (withFirstBuy && needsApproval) {
        setBusy("Approving USDG");
        const h = await sendGuardedTx(provider, {
          from: address,
          to: USDG,
          data: ERC20_IFACE.encodeFunctionData("approve", [LAUNCH_ROUTER, firstBuyIn]),
        });
        const rc = await waitForReceipt(h);
        if (rc.status !== "success") throw new Error("The approval reverted.");
      }
      setBusy("Sign to pin metadata");
      const { tokenURI, metadataUrl } = await pinMetadata(provider, { name: name.trim(), symbol, creator: address, engine });
      const finalInput: RouterInput = { ...routerInput, tokenURI };
      setBusy(withFirstBuy ? "Launching and buying" : "Launching");
      // final dry-run on the router with the pinned calldata: the exact call the wallet signs
      const { asset, poolId } = await simulateRouterLaunch(address, finalInput);
      const hash = await sendGuardedTx(provider, { from: address, to: LAUNCH_ROUTER, data: encodeRouterLaunch(finalInput) });
      const rc = await waitForReceipt(hash, { timeoutMs: 180_000 });
      if (rc.status !== "success") throw new Error("The launch reverted. Nothing was deployed.");
      setLaunched({ asset, poolId, hash, symbol, tokenURI, metadataUrl });
      setSalt(randomSalt());
      refresh(address).catch(() => {});
    } catch (err) {
      setError(txErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 pt-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* ── form column ─────────────────────────────────────────────────── */}
      <div className="min-w-0">
        <div className="mb-2 text-sm text-ink-3">New coin</div>
        <h1 className="text-4xl font-bold">Launch a coin</h1>
        <p className="mt-3 max-w-[540px] text-base leading-relaxed text-ink-2">
          Pick a direction, choose the underlying perp, set the leverage, choose the fee, name
          it. The liquidity locks forever at launch, from your own wallet. After that the
          engine runs itself.
        </p>

        {/* step 1: direction */}
        <section className="mt-9">
          <StepHeading n={1} title="Choose the direction" />
          <OptionGroup label="Direction" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(["long", "short"] as const).map((s) => (
              <OptionCard
                key={s}
                selected={side === s}
                onClick={() => setSide(s)}
                className="flex items-start justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className={`text-lg font-semibold capitalize ${s === "long" ? "text-up" : "text-down"}`}>
                    {s}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-3">
                    {s === "long"
                      ? "The engine profits when the underlying rises."
                      : "The engine profits when the underlying falls."}
                  </span>
                </span>
                <span className={`flex shrink-0 items-center gap-2 ${s === "long" ? "text-up" : "text-down"}`}>
                  {s === "long" ? (
                    <ChartColumnIncreasing aria-hidden size={16} animate={side === s} />
                  ) : (
                    <ChartColumnDecreasing aria-hidden size={16} animate={side === s} />
                  )}
                  {dirCurve(s === "long")}
                </span>
              </OptionCard>
            ))}
          </OptionGroup>
        </section>

        {/* step 2: underlying */}
        <section className="mt-9">
          <StepHeading
            n={2}
            title="Pick the underlying"
            meta={loaded ? `${markets.length} Lighter perps` : undefined}
            action={
              <Input
                value={assetQ}
                onChange={(e) => setAssetQ(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter markets"
                className="w-36"
              />
            }
          />
          <OptionGroup
            label="Underlying market"
            className="grid max-h-[320px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3"
          >
            {!loaded && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11" />)}
            {loaded && filteredMarkets.length === 0 && (
              <p className="col-span-full py-6 text-sm text-ink-3">No market matches “{assetQ}”.</p>
            )}
            {filteredMarkets.map((m) => (
              <OptionCard
                key={m.marketId}
                selected={market === m.symbol}
                onClick={() => setMarket(m.symbol)}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 shadow-none sm:px-3 sm:py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <AssetIcon symbol={m.symbol} size={20} />
                  <span className="truncate text-sm font-medium text-ink">{m.symbol}</span>
                </span>
                {m.change24h != null && (
                  <span className={`num shrink-0 text-xs ${m.change24h >= 0 ? "text-up" : "text-down"}`}>
                    {fmtChange(m.change24h, 1)}
                  </span>
                )}
              </OptionCard>
            ))}
          </OptionGroup>
        </section>

        {/* step 3: leverage */}
        <section className="mt-9">
          <StepHeading
            n={3}
            title="Set the leverage"
            meta={
              <span className="flex items-center gap-1.5">
                <Gauge key={lev} aria-hidden size={14} animate />
                Isolated margin
              </span>
            }
          />
          <OptionGroup label="Leverage" className="flex flex-wrap gap-2">
            {LEVERAGES.map((l) => (
              <OptionCard
                key={l}
                selected={lev === l}
                onClick={() => setLev(l)}
                className={`rounded-lg px-5 py-2.5 text-base font-semibold shadow-none sm:px-5 sm:py-2.5 ${
                  lev === l ? "text-brand" : "text-ink-2"
                }`}
              >
                {l}×
              </OptionCard>
            ))}
          </OptionGroup>
          <p className="mt-2.5 text-sm leading-relaxed text-ink-3">
            Higher leverage means faster burns on a good call, faster liquidation on a bad one.
          </p>
        </section>

        {/* step 4: risk profile */}
        <section className="mt-9">
          <StepHeading n={4} title="Choose the risk profile" meta="When the engine takes profit" />
          <OptionGroup label="Risk profile" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {RISK_PROFILES.map((p) => (
              <OptionCard key={p.key} selected={risk === p.key} onClick={() => setRisk(p.key)}>
                <span className="flex items-baseline justify-between gap-2">
                  <span
                    className={`text-md font-semibold capitalize ${
                      p.key === "degen" ? "text-down" : p.key === "safe" ? "text-up" : "text-brand"
                    }`}
                  >
                    {p.label}
                  </span>
                  <span className="num shrink-0 text-xs text-ink-2">+{p.trigger}%</span>
                </span>
                <span className="mt-1.5 block text-xs leading-relaxed text-ink-3">{p.desc}</span>
              </OptionCard>
            ))}
          </OptionGroup>
        </section>

        {/* step 5: trading fee */}
        <section className="mt-9">
          <StepHeading n={5} title="Set the trading fee" meta="Immutable after launch" />
          <OptionGroup label="Trading fee" className="flex flex-wrap gap-2">
            {FEE_PRESETS.map((f) => (
              <OptionCard
                key={f.bps}
                selected={feeBps === f.bps}
                onClick={() => setFeeBps(f.bps)}
                className={`num rounded-lg px-5 py-2.5 text-base font-semibold shadow-none sm:px-5 sm:py-2.5 ${
                  feeBps === f.bps ? "text-brand" : "text-ink-2"
                }`}
              >
                {f.label}
              </OptionCard>
            ))}
          </OptionGroup>
          <p className="mt-2.5 text-sm leading-relaxed text-ink-3">
            Charged on every swap, both ways, for the life of the pool, and always collected in
            USDG: a buy pays it in the coin and the pool converts it in the same transaction, so
            the engine is fed in full, never in coins to sell later. 95% feeds the coin&apos;s
            engine; 5% is the Doppler protocol fee. A higher fee fuels the position faster and
            slows trading down.
          </p>
        </section>

        {/* step 6: launch protection */}
        <section className="mt-9">
          <StepHeading n={6} title="Launch protection" meta="Anti-snipe, off by default" />
          <OptionGroup label="Launch protection" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <OptionCard selected={!antiSnipe} onClick={() => setAntiSnipe(false)}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-md font-semibold text-ink">Off</span>
                <span className="text-xs text-ink-3">default</span>
              </span>
              <span className="mt-1.5 block text-xs leading-relaxed text-ink-3">
                Everyone pays the flat {feeLabel} trading fee from the first block, nothing else.
                Your bundled first buy pays only Doppler&apos;s slice of it,{" "}
                {firstBuyDopplerCostPct(feeBps, false).toFixed(2)}% of the tokens.
              </span>
            </OptionCard>
            <OptionCard selected={antiSnipe} onClick={() => setAntiSnipe(true)}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-md font-semibold text-brand">On</span>
                <span className="num text-xs text-ink-3">
                  {SNIPE.startFee / 10_000}% → {feeLabel} in {SNIPE.seconds}s
                </span>
              </span>
              <span className="mt-1.5 block text-xs leading-relaxed text-ink-3">
                For the first {SNIPE.seconds} seconds the trading fee itself opens high:{" "}
                {SNIPE.startFee / 10_000}% of the tokens bought at second zero, falling straight to{" "}
                {feeLabel} by second {SNIPE.seconds}, where it stays. Bots that buy the launch block
                keep little; a person buying a minute later pays the normal fee.
              </span>
            </OptionCard>
          </OptionGroup>
          {antiSnipe && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 rounded-xl bg-panel-2 px-4 py-3.5 text-sm leading-relaxed text-ink-2"
            >
              <span className="font-semibold text-ink">Where the opening fee goes.</span> Same place
              as the normal fee: converted to USDG and sent to the engine, minus Doppler&apos;s 5%.
              Your bundled first buy skips the fee itself but still pays Doppler&apos;s slice of the
              opening rate,{" "}
              <span className="num">{firstBuyDopplerCostPct(feeBps, true).toFixed(0)}%</span> of the
              tokens it receives (5% of {SNIPE.startFee / 10_000}%). Turn protection off and that
              drops to {firstBuyDopplerCostPct(feeBps, false).toFixed(2)}%.
            </motion.div>
          )}
        </section>

        {/* step 7: identity + first buy */}
        <section className="mt-9">
          <StepHeading n={7} title="Name it" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 40))}
              placeholder="Coin name"
              aria-label="Coin name"
              className="h-11 text-base"
            />
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10))}
              placeholder="TICKER"
              aria-label="Ticker"
              className="num h-11 text-base uppercase"
            />
          </div>
          <div className="mt-3 rounded-xl border border-border bg-void px-4 py-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-ink">First buy, optional</span>
              {acct && (
                <button
                  type="button"
                  className="min-w-0 truncate text-xs text-ink-3 transition-colors hover:text-brand"
                  onClick={() => setFirstBuy(ethers.utils.formatUnits(acct.usdg, 6))}
                >
                  Balance {fmtUsdg(acct.usdg)} USDG, max
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <input
                value={firstBuy}
                onChange={(e) => setFirstBuy(clampUsdgInput(e.target.value))}
                placeholder="0.00"
                inputMode="decimal"
                aria-label="First buy in USDG"
                className="num w-full min-w-0 bg-transparent text-2xl text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <span className="shrink-0 text-sm text-ink-2">USDG</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-3">
              Bundled into the launch transaction, so it is the pool&apos;s first swap by
              construction: nobody can trade before you. The fee is waived on it except
              Doppler&apos;s slice: {firstBuyDopplerCostPct(feeBps, antiSnipe).toFixed(2)}% of the
              tokens.
            </p>
          </div>
        </section>

        {/* launch */}
        <Panel className="mt-9">
          <PanelHeader>
            <PanelTitle className="flex items-center gap-2">
              <Sparkles aria-hidden size={15} animateOnView className="text-brand" />
              Launch
            </PanelTitle>
            <PanelMeta>
              Signed by your wallet · router{" "}
              <a className="num underline underline-offset-2" href={explorerAddr(LAUNCH_ROUTER)} target="_blank" rel="noreferrer">
                {short(LAUNCH_ROUTER)}
              </a>
            </PanelMeta>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-3.5">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-ink-3">Token address</dt>
              <dd className="num min-w-0 truncate text-ink">
                {predicted ? (
                  <a className="underline underline-offset-2" href={explorerAddr(predicted.asset)} target="_blank" rel="noreferrer">
                    {predicted.asset}
                  </a>
                ) : address && ready ? (
                  simError ? <span className="text-down">{simError}</span> : "computing…"
                ) : (
                  "name the coin to preview"
                )}
              </dd>
              <dt className="text-ink-3">Opens at</dt>
              <dd className="num text-ink">≈ ${mcapUsd.toFixed(0)} market cap, 1B supply, all in the pool</dd>
              <dt className="text-ink-3">Fee routing</dt>
              <dd className="min-w-0 truncate text-ink">
                all in USDG · 95% engine hub{" "}
                <a className="num text-ink-2 underline underline-offset-2" href={explorerAddr(LAUNCH_FEE_HUB)} target="_blank" rel="noreferrer">
                  {short(LAUNCH_FEE_HUB)}
                </a>{" "}
                · 5% Doppler
              </dd>
              {withFirstBuy && (
                <>
                  <dt className="text-ink-3">First buy gets</dt>
                  <dd className="num text-ink">
                    {predicted?.firstBuyOut
                      ? `≈ ${Number(ethers.utils.formatEther(predicted.firstBuyOut)).toLocaleString("en-US", { maximumFractionDigits: 0 })} $${symbol || "TICKER"}`
                      : "simulating…"}
                  </dd>
                </>
              )}
              <dt className="text-ink-3">Gas</dt>
              <dd className="num text-ink">
                {predicted?.gas ? `~${predicted.gas.toNumber().toLocaleString("en-US")} units` : "estimated at signing"}
              </dd>
            </dl>

            <ChainGate connectLabel="Connect wallet to launch">
              <Button
                size="xl"
                className="w-full"
                onClick={launch}
                disabled={!routerInput || !predicted || !!busy || insufficient}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {busy ??
                  (!ready
                    ? "Name the coin"
                    : insufficient
                      ? "Not enough USDG for the first buy"
                      : needsApproval
                        ? `Approve USDG and launch $${symbol}`
                        : withFirstBuy
                          ? `Launch $${symbol} and buy ${fmtUsdg(firstBuyIn)} USDG`
                          : `Launch $${symbol}`)}
              </Button>
            </ChainGate>

            {launched && (
              <div className="rounded-xl bg-brand-soft px-4 py-3.5 text-sm leading-relaxed text-ink-2" role="status">
                <span className="font-semibold text-brand">${launched.symbol} is live.</span>{" "}
                <a className="underline underline-offset-2" href={explorerToken(launched.asset)} target="_blank" rel="noreferrer">
                  token
                </a>{" "}
                ·{" "}
                <a className="underline underline-offset-2" href={dexscreenerPool(launched.poolId)} target="_blank" rel="noreferrer">
                  DexScreener
                </a>{" "}
                ·{" "}
                <a className="underline underline-offset-2" href={explorerTx(launched.hash)} target="_blank" rel="noreferrer">
                  transaction
                </a>{" "}
                ·{" "}
                <a className="underline underline-offset-2" href={launched.metadataUrl} target="_blank" rel="noreferrer">
                  metadata
                </a>
              </div>
            )}
            {error && (
              <p className="text-sm leading-relaxed text-down" role="alert">
                {error}
              </p>
            )}

            <p className="text-xs leading-relaxed text-ink-3">
              The seal and the metadata are pinned to IPFS first, then one transaction through the
              multiply router deploys the token, seeds the pool one-sided and locks it. The router
              only enforces the shape of the launch; the coin, its pool and its lock are Doppler
              contracts with no owner, no migration and no admin key. The lock is irreversible.
            </p>
          </PanelBody>
        </Panel>
      </div>

      {/* ── preview column ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
        <Panel>
          <PanelHeader>
            <PanelTitle>Live preview</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <div className="hatch relative mx-auto flex h-[188px] w-full items-center justify-center overflow-hidden rounded-xl">
              <CoinSeal leverage={lev} side={side} riskProfile={risk} size={176} rings={4} className="text-brand" />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                <div className="max-w-full truncate text-lg font-semibold text-ink">${symbol || "TICKER"}</div>
                <div className="max-w-full truncate text-xs text-ink-3">{name || "Your coin"}</div>
              </div>
            </div>

            <Reveal className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-4">
              {[
                { label: "Leverage", value: `${lev}×` },
                { label: "Underlying", value: market },
                { label: "Direction", value: side },
                { label: "Fee", value: feeLabel },
              ].map((c) => (
                <RevealItem key={c.label} className="min-w-0 bg-panel-2 px-2 py-3 text-center">
                  <div
                    className={`truncate text-md font-semibold capitalize ${
                      c.label === "Direction" ? (side === "long" ? "text-up" : "text-down") : "text-ink"
                    }`}
                  >
                    {c.value}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-3">{c.label}</div>
                </RevealItem>
              ))}
            </Reveal>

            <div className="mt-4 rounded-xl border border-border bg-void px-4 py-3.5">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                  <AssetIcon symbol={market} size={18} />
                  <span className="truncate">{market} / USD</span>
                </span>
                {selected?.change24h != null && (
                  <Badge variant={selected.change24h >= 0 ? "up" : "down"} className="num shrink-0">
                    {fmtChange(selected.change24h)} 24h
                  </Badge>
                )}
              </div>
              <div className="num mt-2 truncate text-3xl font-semibold text-ink">
                <AnimatedNumber value={selected?.mark ?? null} format="mark" />
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
                Mark price on Lighter · the engine trades this at {lev}×
              </p>
            </div>

            <motion.p
              key={`${market}-${lev}-${side}-${risk}-${feeBps}-${antiSnipe}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28 }}
              className="mt-4 rounded-xl bg-brand-soft px-4 py-3.5 text-sm leading-relaxed text-ink-2"
            >
              <span className="font-semibold text-brand">
                {market} {lev}× {side} · {risk} · {feeLabel} fee{antiSnipe ? " · protected" : ""}
              </span>
              . If {market} moves {side === "long" ? "up" : "down"} 10%, the coin&apos;s perp treasury
              gains ~{(10 * lev).toFixed(0)}%. Each deposit is its own tranche that banks fully at +
              {trigger}%; realized profits flow back on-chain: 75% buys and burns the coin, 25% to
              treasury.
            </motion.p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>How it works</PanelTitle>
          </PanelHeader>
          <ol className="flex flex-col gap-3.5 p-4 sm:p-5">
            {[
              `The token deploys with a 1B fixed supply and no owner, all of it seeded one-sided into a Uniswap v4 pool at roughly $${mcapUsd.toFixed(0)} mcap, through Doppler's Airlock.`,
              "The pool is locked by its fee beneficiaries. Nobody can pull the liquidity, not you, not us, not Doppler.",
              `Every swap pays ${feeLabel}, always collected in USDG: 95% into the coin's engine, 5% to Doppler. Small fees pool on the hook until they pass ${HOOK_FLUSH_EPSILON_USDG} USDG, then flush. The protocol earns only 25% of realized profits.`,
              `At ${OPEN_GATE_LABEL} the engine opens the ${lev}× ${side} on ${market}; profits are withdrawn on your risk profile, bought back and burned.`,
            ].map((step, i) => (
              <li key={i} className="flex min-w-0 gap-3 text-sm leading-relaxed text-ink-2">
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-ink-3"
                >
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
