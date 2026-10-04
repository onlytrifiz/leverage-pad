"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { ChevronDown, ImagePlus, X } from "lucide-react";
import { cn } from "cn";
import { useWallet, ChainGate } from "@/components/wallet";
import { useMarkets } from "./markets-provider";
import AssetIcon from "./AssetIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { OptionCard, OptionGroup } from "@/components/ui/option-card";
import { CoinSeal } from "@/components/brand/CoinSeal";
import { Banknote } from "@/components/brand/Banknote";
import { EngravedArt } from "@/components/brand/EngravedArt";
import { fmtChange } from "@/lib/format";
import { USDG, LAUNCH_FEE_HUB, LAUNCH_ROUTER, explorerTx, explorerToken, explorerAddr } from "@/lib/clientConfig";
import { multicall } from "@/lib/multicall";
import { sendGuardedTx, waitForReceipt, txErrorMessage } from "@/lib/tx";
import {
  FEE_PRESETS,
  SNIPE,
  firstBuyDopplerCostPct,
  ERC20_IFACE,
  buildCreateParams,
  simulateBundle,
  simulateRouterLaunch,
  readFeeSplit,
  type FeeSplit,
  encodeRouterLaunch,
  routerSalt,
  readProtocolOwner,
  metadataSignMessage,
  metadataContentHash,
  IMAGE_MAX_BYTES,
  type MetadataContent,
  type RouterInput,
  routerEngine,
  NAME_MAX,
  SYMBOL_MAX,
  launchTicks,
  randomSalt,
  readProvider,
  dexscreenerPool,
  FEE_SPLIT_PCT,
  ROUTER_LEVERAGES,
  TP_MIN_PCT,
  TP_PRESETS,
  TP_MOVE_MAX_PCT,
  maxTakeProfitPct,
  MANAGED_DELAY_HOURS,
  MANAGED_LIVE,
  type EngineParams,
} from "@/lib/doppler";
import { AnimatedNumber } from "@/components/motion";
import AssetPicker from "@/components/launch/AssetPicker";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Launch configurator: direction → underlying → leverage → take-profit → fee → identity
 * (name, logo, links), with engine control and launch protection folded under Advanced,
 * then the launch itself, signed by the connected
 * wallet. The deploy goes through the multiply launch router, which builds the
 * Doppler launch on-chain from these inputs; see `lib/doppler.ts` for the
 * mirror encoders used to predict the token address before signing.
 */

const LEVERAGES: readonly number[] = ROUTER_LEVERAGES;

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
  input: { name: string; symbol: string; creator: string; engine: EngineParams },
  content: { description: string; socials: MetadataContent["socials"]; logo: Logo | null }
) {
  const ts = Math.floor(Date.now() / 1000);
  const contentHash = metadataContentHash({
    description: content.description,
    socials: content.socials,
    imageHash: content.logo?.hash ?? "",
  });
  const message = metadataSignMessage({ ...input, ts, contentHash });
  const signature = (await provider.request({
    method: "personal_sign",
    params: [ethers.utils.hexlify(ethers.utils.toUtf8Bytes(message)), input.creator],
  })) as string;
  const res = await fetch("/api/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      description: content.description,
      socials: content.socials,
      image: content.logo?.dataUrl,
      ts,
      signature,
    }),
  });
  const json = (await res.json()) as { tokenURI?: string; gatewayUrl?: string; error?: string };
  if (!res.ok || !json.tokenURI) throw new Error(json.error ?? "Could not pin the metadata.");
  return { tokenURI: json.tokenURI, metadataUrl: json.gatewayUrl ?? `https://ipfs.io/ipfs/${json.tokenURI.replace("ipfs://", "")}` };
}

/** an uploaded logo: what gets sent (data URL) and what gets signed (sha256 of its bytes) */
type Logo = { dataUrl: string; hash: string; name: string };
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const DESCRIPTION_MAX = 280;
const LINK_MAX = 200;

/**
 * The same cleaning the metadata endpoint applies, so the digest the wallet signs matches the
 * one the server recomputes: control characters (newlines included) out, trimmed, capped.
 */
const cleanText = (s: string, max: number) =>
  // trimmed again after the cap: a cut can leave a trailing space the server would trim
  s.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max).trim();

/** a link as typed ("x.com/foo", "@foo", "http://…") turned into the https URL that gets pinned */
function normalizeLink(raw: string, kind: "website" | "x" | "telegram"): string {
  const v = raw.trim();
  if (!v) return "";
  if (v.startsWith("@") && kind !== "website") return `https://${kind === "x" ? "x.com" : "t.me"}/${v.slice(1)}`;
  const url = /^https?:\/\//i.test(v) ? v.replace(/^http:\/\//i, "https://") : `https://${v}`;
  return /^https:\/\/[^\s]+$/i.test(url) ? url.slice(0, LINK_MAX) : "";
}

/** USDG has 6 decimals: anything finer would make parseUnits throw and silently drop the first buy. */
const clampUsdgInput = (v: string) => {
  const cleaned = v.replace(/[^0-9.]/g, "");
  const [i, d] = cleaned.split(".");
  return d === undefined ? i : `${i}.${d.slice(0, 6)}`;
};

export default function LaunchForm({
  initialMarket = "NVDA",
  initialSide = "long",
}: {
  /** preset from the URL (`/launch?market=TSLA&side=short`), e.g. from the market's movers */
  initialMarket?: string;
  initialSide?: "long" | "short";
}) {
  const { address, provider } = useWallet();
  const { markets, loaded } = useMarkets();
  const [side, setSide] = useState<"long" | "short">(initialSide);
  const [market, setMarket] = useState(initialMarket);
  const [lev, setLev] = useState(3);
  // the pick is kept as chosen; what applies is capped by the leverage, so lowering the
  // leverage pulls the target in and raising it again gives the pick back
  const [tpPick, setTp] = useState(50);
  const tpMax = maxTakeProfitPct(lev);
  const tp = Math.min(tpPick, tpMax);
  const [managed, setManaged] = useState(false);
  const [feeBps, setFeeBps] = useState<number>(200);
  const [antiSnipe, setAntiSnipe] = useState(false);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [firstBuy, setFirstBuy] = useState("");
  const [description, setDescription] = useState("");
  const [links, setLinks] = useState({ website: "", x: "", telegram: "" });
  const [logo, setLogo] = useState<Logo | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [salt, setSalt] = useState<string>(() => randomSalt());

  const [predicted, setPredicted] = useState<{ asset: string; gas: ethers.BigNumber | null; firstBuyOut: ethers.BigNumber | null } | null>(null);
  /** the coin's own fee sink and the split the router will lock in; null = fees go to the hub */
  const [feeSplit, setFeeSplit] = useState<FeeSplit | null>(null);
  const [protocolOwner, setProtocolOwner] = useState<string | undefined>(undefined);
  const [simError, setSimError] = useState<string | null>(null);
  const [acct, setAcct] = useState<{ usdg: ethers.BigNumber; allowance: ethers.BigNumber } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Launched | null>(null);

  const selected = markets.find((m) => m.symbol === market) ?? null;
  /** Lighter's cap for the chosen market; null until the list has loaded */
  const maxLev = selected?.maxLeverage ?? null;
  const levOk = maxLev == null || lev <= maxLev;
  /*
   * Changing side floods the page with the new side's ink from where the
   * click landed, then the palette underneath has already turned.
   */
  const [wash, setWash] = useState<{ x: number; y: number; to: "long" | "short"; id: number } | null>(null);
  const switchSide = (to: "long" | "short", e?: { clientX: number; clientY: number }) => {
    if (to === side) return;
    setSide(to);
    const x = e?.clientX ?? (typeof window !== "undefined" ? window.innerWidth / 2 : 0);
    const y = e?.clientY ?? (typeof window !== "undefined" ? window.innerHeight / 2 : 0);
    setWash((w) => ({ x, y, to, id: (w?.id ?? 0) + 1 }));
  };

  /** choosing a market brings the leverage down to what that market allows, never up */
  const pickMarket = (symbol: string) => {
    setMarket(symbol);
    const cap = markets.find((m) => m.symbol === symbol)?.maxLeverage;
    if (cap != null && lev > cap) {
      const allowed = LEVERAGES.filter((l) => l <= cap);
      setLev(allowed[allowed.length - 1] ?? LEVERAGES[0]);
    }
  };
  const trigger = tp;
  const feeLabel = FEE_PRESETS.find((f) => f.bps === feeBps)!.label;
  const { mcapUsd } = launchTicks();

  const engine: EngineParams = useMemo(
    () => ({ market, side, leverage: lev, takeProfitPct: tp, managed }),
    [market, side, lev, tp, managed]
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
    return { name: name.trim(), symbol, tokenURI: "", fee: feeBps * 100, antiSnipe, mcap: 0, firstBuy: firstBuyIn, salt, ...routerEngine(engine) };
  }, [address, ready, name, symbol, feeBps, antiSnipe, firstBuyIn, salt, engine]);
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
   * The sink address depends on launcher and salt alone, so it can be shown before signing.
   * Read from the router, never assumed: a router without sinks configured answers null and
   * the form says "hub", which is then also what the launch will do.
   */
  /** which address the split was read for: a stale read must not pass for the current one */
  const [splitFor, setSplitFor] = useState<string | null>(null);
  useEffect(() => {
    if (!address) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFeeSplit(null);
      return;
    }
    let live = true;
    readFeeSplit(address, salt).then((s) => {
      if (!live) return;
      setFeeSplit(s);
      setSplitFor(`${address}:${salt}`);
    });
    return () => {
      live = false;
    };
  }, [address, salt]);

  /*
   * Three cases, kept apart. Read from the router: the coin's own split. The
   * router answered "no sink": the hub, 95% engine. Not read yet (no wallet,
   * or the read in flight): the protocol's published split, which is what a
   * sink-enabled router locks in. The form used to show the hub's 95% in that
   * last case, contradicting the docs for every visitor without a wallet.
   */
  const splitKnown = !!address && splitFor === `${address}:${salt}`;
  const enginePct = feeSplit ? feeSplit.engineBps / 100 : splitKnown ? 95 : FEE_SPLIT_PCT.engine;
  const treasuryPct = feeSplit ? feeSplit.treasuryBps / 100 : splitKnown ? 0 : FEE_SPLIT_PCT.treasury;
  const viaHub = splitKnown && !feeSplit;

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
      const { tokenURI, metadataUrl } = await pinMetadata(
        provider,
        { name: name.trim(), symbol, creator: address, engine },
        {
          description: cleanText(description, DESCRIPTION_MAX),
          socials: {
            website: normalizeLink(links.website, "website"),
            x: normalizeLink(links.x, "x"),
            telegram: normalizeLink(links.telegram, "telegram"),
          },
          logo,
        }
      );
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

  /* what each choice means, in plain numbers, recomputed as you change it */
  const up = side === "long";
  const move10 = 10 * lev;
  const liqAway = 100 / lev;
  const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

  const launchButton = (
    <ChainGate connectLabel="Connect wallet to launch">
      <Button size="xl" className="w-full" onClick={launch} disabled={!routerInput || !predicted || !!busy || insufficient || !levOk}>
        {busy && <Spinner data-icon="inline-start" />}
        {busy ??
          (!ready
            ? "Name the coin"
            : !levOk
              ? `${market} allows up to ${maxLev}x`
              : insufficient
              ? "Not enough USDG for the first buy"
              : needsApproval
                ? `Approve USDG and launch $${symbol}`
                : withFirstBuy
                  ? `Launch $${symbol} and buy ${fmtUsdg(firstBuyIn)} USDG`
                  : `Launch $${symbol}`)}
      </Button>
    </ChainGate>
  );

  return (
    <div data-side={side} className="launch-root">
      <SideWash wash={wash} />
      {/* ── the night band: what this page does, in one line ─────────────── */}
      <section className="intro-night behind-nav relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]">
        <div aria-hidden className="pointer-events-none absolute top-1/2 right-[-6%] -z-10 -translate-y-1/2 text-mint/[0.2]">
          <CoinSeal leverage={lev} side={side} takeProfitPct={tp} size={760} rings={4} spin={120} className="w-[110vw] max-w-[760px]" />
        </div>
        <div className="mx-auto w-full max-w-[1320px] px-4 pt-10 pb-10 sm:px-5 sm:pt-14 sm:pb-12">
          <h1 className="font-display text-[clamp(44px,7vw,92px)] leading-[0.95] font-bold tracking-[-0.04em] text-night-ink">
            Print your <span className="type-engraved [--ink-c:var(--color-mint)]">coin.</span>
          </h1>
          <p className="mt-4 max-w-[52ch] text-lg leading-relaxed text-night-ink-2">
            Pick what its fees trade, name it, sign once. The pool locks forever at launch and the engine runs itself.
          </p>
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4">
            {[
              { k: "Opens at", v: `~${usd0(mcapUsd)} market cap` },
              { k: "Supply", v: "1B, all in the pool" },
              { k: "Liquidity", v: "locked from block one" },
            ].map((f) => (
              <div key={f.k}>
                <dt className="text-xs text-night-ink-2">{f.k}</dt>
                <dd className="mt-0.5 font-semibold text-night-ink">{f.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-[1320px] grid-cols-1 gap-8 px-4 pt-10 sm:px-5 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-12">
        {/* ── the press: the note prints as you choose (first on a phone) ── */}
        <aside className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[calc(var(--nav-h)+16px)] lg:self-start">
          <div className="relative">
            <Banknote
              symbol={symbol || "TICKER"}
              name={name.trim() || "Your coin"}
              market={market}
              side={side}
              leverage={lev}
              managed={managed}
              serial={predicted?.asset ?? launched?.asset ?? "0x0000000000000000000000000000000000000000"}
            />
            <AnimatePresence>
              {launched && (
                <motion.div
                  key="stamp"
                  initial={{ opacity: 0, scale: 2.2, rotate: -24 }}
                  animate={{ opacity: 1, scale: 1, rotate: -12 }}
                  transition={{ type: "spring", stiffness: 260, damping: 16 }}
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <span className="rounded-lg border-[3px] border-double border-down px-5 py-2 font-display text-[clamp(22px,4vw,40px)] font-bold tracking-[0.2em] text-down/90 uppercase mix-blend-multiply">
                    Issued
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <motion.p
            key={`${market}-${lev}-${side}-${tp}-${feeBps}-${managed}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="mt-5 text-md leading-relaxed text-ink-2"
          >
            <span className="font-semibold text-ink">
              Every trade on ${symbol || "TICKER"} funds a {lev}x {side} on {market}.
            </span>{" "}
            If {market} moves 10% {up ? "up" : "down"}, the position gains about {move10}%. Each deposit banks at +{trigger}%, then 75%
            of the profit buys the coin back and burns it.
          </motion.p>

          {/* live mark of the chosen asset */}
          <div className="mt-5 flex items-center justify-between gap-3 rounded-[14px] border border-line bg-panel px-4 py-3">
            <span className="flex min-w-0 items-center gap-2">
              <AssetIcon symbol={market} size={20} />
              <span className="truncate font-semibold text-ink">{market}</span>
              <span className="text-xs text-ink-3">on Lighter</span>
            </span>
            <span className="flex items-baseline gap-2">
              <span className="num font-semibold text-ink">
                <AnimatedNumber value={selected?.mark ?? null} format="mark" />
              </span>
              {selected?.change24h != null && (
                <span className={`num text-xs ${selected.change24h >= 0 ? "text-up" : "text-down"}`}>{fmtChange(selected.change24h, 1)}</span>
              )}
            </span>
          </div>

          {/* launch: desktop keeps it under the note; a phone gets it after the steps */}
          <div className="mt-5 hidden lg:block">
            <LaunchPanel
              {...{ predicted, simError, address, ready, mcapUsd, viaHub, enginePct, treasuryPct, feeSplit, withFirstBuy, symbol, launched, error }}
              button={launchButton}
            />
          </div>
        </aside>

        {/* ── the steps ───────────────────────────────────────────────────── */}
        <ol className="min-w-0 lg:col-start-1 lg:row-start-1">
          <Step n={1} title="Which way" meta="The engine profits when the asset moves this way">
            <OptionGroup label="Direction" className="grid grid-cols-2 gap-3">
              {(["long", "short"] as const).map((s) => (
                <OptionCard
                  key={s}
                  selected={side === s}
                  onClick={(e) => switchSide(s, e)}
                  className="group relative overflow-hidden p-0 sm:p-0"
                >
                  {/* a fixed box with the art standing on its floor: bull and bear share a baseline */}
                  <div
                    className={`flex h-[120px] items-end justify-center px-4 pt-4 transition-colors sm:h-[180px] sm:px-5 ${
                      side === s ? "text-ink" : "text-ink-3 group-hover:text-ink-2"
                    }`}
                  >
                    <EngravedArt name={s === "long" ? "bull" : "bear"} fit="height" />
                  </div>
                  <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-5">
                    <span className={`font-display text-xl font-bold capitalize ${s === "long" ? "text-up" : "text-down"}`}>{s}</span>
                    <span className={s === "long" ? "text-up" : "text-down"}>{dirCurve(s === "long")}</span>
                  </div>
                </OptionCard>
              ))}
            </OptionGroup>
          </Step>

          <Step n={2} title="What its fees trade" meta={loaded ? `${markets.length} Lighter perps` : undefined}>
            <AssetPicker
              markets={markets}
              loaded={loaded}
              value={market}
              onPick={(sym, hint) => {
                pickMarket(sym);
                if (hint) switchSide(hint);
              }}
              levCap={LEVERAGES[LEVERAGES.length - 1]}
            />
          </Step>

          <Step n={3} title="How hard" meta={maxLev != null ? `Up to ${Math.min(maxLev, LEVERAGES[LEVERAGES.length - 1])}x on ${market}` : "Isolated margin"}>
            <LeverageDial value={lev} onChange={setLev} max={maxLev} />
            {maxLev != null && maxLev > LEVERAGES[LEVERAGES.length - 1] && (
              <p className="mt-3 text-xs leading-relaxed text-ink-3">
                Lighter allows up to {maxLev}x on {market}; launches go up to {LEVERAGES[LEVERAGES.length - 1]}x for now.
              </p>
            )}
            {maxLev != null && maxLev < LEVERAGES[LEVERAGES.length - 1] && (
              <p className="mt-3 text-xs leading-relaxed text-ink-3">
                Lighter allows at most {maxLev}x on {market}. Higher stops are off: above the venue&apos;s limit the position could
                never open.
              </p>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Readout tone="up" label={`If ${market} moves 10% ${up ? "up" : "down"}`} value={`+${move10}%`} note="on the position" />
              <Readout tone="down" label="Liquidation" value={`~${liqAway.toFixed(liqAway < 10 ? 1 : 0)}%`} note={`against you, before fees and funding`} />
            </div>
          </Step>

          <Step n={4} title="When it takes profit" meta="Per deposit">
            <TakeProfitSlider value={tp} max={tpMax} onChange={setTp} market={market} leverage={lev} up={up} />
          </Step>

          <Step n={5} title="The trading fee" meta="Fixed forever at launch">
            <OptionGroup label="Trading fee" className="grid grid-cols-4 gap-2">
              {FEE_PRESETS.map((f) => (
                <OptionCard
                  key={f.bps}
                  selected={feeBps === f.bps}
                  onClick={() => setFeeBps(f.bps)}
                  className={`num rounded-xl px-0 py-3 text-center text-lg font-semibold shadow-none sm:px-0 sm:py-3 ${feeBps === f.bps ? "text-brand" : "text-ink-2"}`}
                >
                  {f.label}
                </OptionCard>
              ))}
            </OptionGroup>
          </Step>

          <Step n={6} title="Name it" meta="This is what gets printed">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
              <label className="block">
                <span className="mb-1.5 flex justify-between text-xs text-ink-3">
                  <span>Name</span>
                  <span className="num">
                    {name.length}/{NAME_MAX}
                  </span>
                </span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                  placeholder="Long Nvidia Forever"
                  className="h-12 text-lg"
                />
              </label>
              {/* the ticker is the creator's, as typed: any characters, no forced case; only spaces and a length cap */}
              <label className="block">
                <span className="mb-1.5 flex justify-between text-xs text-ink-3">
                  <span>Ticker</span>
                  <span className="num">
                    {symbol.length}/{SYMBOL_MAX}
                  </span>
                </span>
                <Input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.replace(/\s/g, "").slice(0, SYMBOL_MAX))}
                  placeholder="LNVDA"
                  className="num h-12 text-lg"
                />
              </label>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[112px_minmax(0,1fr)]">
              <LogoPicker
                logo={logo}
                error={logoError}
                onPick={async (file) => {
                  setLogoError(null);
                  if (!LOGO_TYPES.includes(file.type)) return setLogoError("PNG, JPEG, WebP or GIF.");
                  if (file.size > IMAGE_MAX_BYTES) return setLogoError("Under 1 MB, please.");
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const dataUrl = await new Promise<string>((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => resolve(String(r.result));
                    r.onerror = () => reject(r.error);
                    r.readAsDataURL(file);
                  });
                  setLogo({ dataUrl, hash: ethers.utils.sha256(bytes), name: file.name });
                }}
                onClear={() => {
                  setLogo(null);
                  setLogoError(null);
                }}
                fallback={<CoinSeal leverage={lev} side={side} takeProfitPct={tp} size={96} rings={3} spin={0} />}
              />
              <label className="block min-w-0">
                <span className="mb-1.5 flex justify-between text-xs text-ink-3">
                  <span>Description, optional</span>
                  <span className="num">
                    {description.length}/{DESCRIPTION_MAX}
                  </span>
                </span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
                  rows={4}
                  placeholder={`What this coin is about. Left empty, it says what its fees trade.`}
                  className="block w-full resize-none rounded-[10px] border border-input bg-card px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                />
              </label>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  { key: "website", label: "Website", placeholder: "yourcoin.xyz" },
                  { key: "x", label: "X", placeholder: "@yourcoin" },
                  { key: "telegram", label: "Telegram", placeholder: "@yourcoin" },
                ] as const
              ).map((f) => {
                const raw = links[f.key];
                const bad = raw.trim() !== "" && !normalizeLink(raw, f.key);
                return (
                  <label key={f.key} className="block min-w-0">
                    <span className="mb-1.5 block text-xs text-ink-3">{f.label}, optional</span>
                    <Input
                      value={raw}
                      onChange={(e) => setLinks((l) => ({ ...l, [f.key]: e.target.value.slice(0, LINK_MAX) }))}
                      placeholder={f.placeholder}
                      aria-invalid={bad || undefined}
                      inputMode="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-10"
                    />
                  </label>
                );
              })}
            </div>

            <div className="mt-4 rounded-[14px] border border-line bg-panel px-4 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-ink">First buy, optional</span>
                {acct && (
                  <span className="text-xs text-ink-3">
                    Balance <span className="num">{fmtUsdg(acct.usdg)}</span> USDG
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <input
                  value={firstBuy}
                  onChange={(e) => setFirstBuy(clampUsdgInput(e.target.value))}
                  placeholder="0.00"
                  inputMode="decimal"
                  aria-label="First buy in USDG"
                  className="num w-full min-w-0 bg-transparent text-3xl text-ink placeholder:text-ink-3 focus:outline-none"
                />
                <span className="shrink-0 text-sm text-ink-2">USDG</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {["10", "50", "100"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setFirstBuy(v)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${firstBuy === v ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-2 hover:border-line-2"}`}
                  >
                    ${v}
                  </button>
                ))}
                {acct && (
                  <button
                    type="button"
                    onClick={() => setFirstBuy(ethers.utils.formatUnits(acct.usdg, 6))}
                    className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-line-2"
                  >
                    Max
                  </button>
                )}
                {firstBuy && (
                  <button type="button" onClick={() => setFirstBuy("")} className="px-1 text-xs text-ink-3 hover:text-ink">
                    Clear
                  </button>
                )}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-3">
                Bundled into the launch, so it is the pool&apos;s first swap: nobody trades before you. The fee is waived except
                Doppler&apos;s slice, {firstBuyDopplerCostPct(feeBps, antiSnipe).toFixed(2)}% of the tokens.
                {withFirstBuy && predicted?.firstBuyOut && (
                  <>
                    {" "}
                    You get about{" "}
                    <span className="num font-semibold text-ink">
                      {Number(ethers.utils.formatEther(predicted.firstBuyOut)).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </span>{" "}
                    ${symbol || "TICKER"}.
                  </>
                )}
              </p>
            </div>
          </Step>

          {/* the choices most launches leave alone, folded away so the flow stays short */}
          <li className="relative list-none pb-10 pl-11 sm:pl-14">
            <span
              aria-hidden
              className="absolute top-0 left-0 flex size-8 items-center justify-center rounded-full border border-dashed border-line-2 bg-panel text-ink-3 sm:size-10"
            >
              <ChevronDown size={16} className={cn("transition-transform", advanced && "rotate-180")} />
            </span>
            <button
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              className="flex min-h-8 w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-left sm:min-h-10"
            >
              <span className="font-display text-xl font-semibold text-ink sm:text-2xl">Advanced</span>
              <span className="text-sm text-ink-3">{advanced ? "Hide" : `${managed ? "Managed by you" : "Fixed forever"} · Protection ${antiSnipe ? "on" : "off"}`}</span>
            </button>
            <AnimatePresence initial={false}>
              {advanced && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-8 pt-5">
                    <section>
                      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-base font-semibold text-ink">Who can change it</h3>
                        <span className="text-sm text-ink-3">Market and side never change</span>
                      </div>
                      <OptionGroup label="Engine control" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <OptionCard selected={!managed} onClick={() => setManaged(false)}>
                          <span className="font-semibold text-ink">Fixed forever</span>
                          <span className="mt-1 block text-xs leading-relaxed text-ink-3">
                            Leverage and take-profit stay as launched. Holders buy a rule that cannot move.
                          </span>
                        </OptionCard>
                        <OptionCard
                          selected={managed}
                          disabled={!MANAGED_LIVE}
                          onClick={() => setManaged(true)}
                          className="disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-card"
                        >
                          <span className="flex items-baseline justify-between gap-2">
                            <span className={MANAGED_LIVE ? "font-semibold text-brand" : "font-semibold text-ink-2"}>Managed by you</span>
                            {MANAGED_LIVE ? (
                              <span className="text-xs text-ink-3">{MANAGED_DELAY_HOURS}h notice</span>
                            ) : (
                              <span className="rounded-full border border-line-2 px-2 py-px text-2xs font-medium tracking-wide text-ink-3 uppercase">
                                Soon
                              </span>
                            )}
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-ink-3">
                            You can retune leverage and take-profit later. Every change is announced on-chain and lands{" "}
                            {MANAGED_DELAY_HOURS} hours after, and the coin carries a Managed badge everywhere.
                          </span>
                        </OptionCard>
                      </OptionGroup>
                    </section>
                    <section>
                      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-base font-semibold text-ink">Launch protection</h3>
                        <span className="text-sm text-ink-3">Anti-snipe, off by default</span>
                      </div>
                      <OptionGroup label="Launch protection" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <OptionCard selected={!antiSnipe} onClick={() => setAntiSnipe(false)}>
                          <span className="font-semibold text-ink">Off</span>
                          <span className="mt-1 block text-xs leading-relaxed text-ink-3">
                            Everyone pays the flat {feeLabel} from the first block. Your first buy pays only Doppler&apos;s slice,{" "}
                            {firstBuyDopplerCostPct(feeBps, false).toFixed(2)}% of the tokens.
                          </span>
                        </OptionCard>
                        <OptionCard selected={antiSnipe} onClick={() => setAntiSnipe(true)}>
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="font-semibold text-brand">On</span>
                            <span className="num text-xs text-ink-3">
                              {SNIPE.startFee / 10_000}% → {feeLabel} in {SNIPE.seconds}s
                            </span>
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-ink-3">
                            The fee opens high and falls to {feeLabel} in {SNIPE.seconds} seconds. Bots buying the launch block keep little.
                          </span>
                        </OptionCard>
                      </OptionGroup>
                      <AnimatePresence initial={false}>
                        {antiSnipe && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                          >
                            <ProtectionCurve endPct={feeBps / 100} />
                            <p className="mt-2 text-xs leading-relaxed text-ink-3">
                              The opening fee goes where the normal one goes: to the engine in USDG, minus Doppler&apos;s 5%. Your bundled
                              first buy pays Doppler&apos;s slice of the opening rate,{" "}
                              <span className="num">{firstBuyDopplerCostPct(feeBps, true).toFixed(0)}%</span> of its tokens.
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </section>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </li>

          {/* a phone gets the launch panel at the end of the flow */}
          <li className="mt-8 list-none lg:hidden">
            <LaunchPanel
              {...{ predicted, simError, address, ready, mcapUsd, viaHub, enginePct, treasuryPct, feeSplit, withFirstBuy, symbol, launched, error }}
              button={launchButton}
            />
          </li>
        </ol>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────── pieces ───── */

/** one step of the flow: a numbered node on a rail, its content beside it */
function Step({
  n,
  title,
  meta,
  last,
  children,
}: {
  n: number;
  title: string;
  meta?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative list-none pb-10 pl-11 sm:pl-14">
      {!last && <span aria-hidden className="absolute top-9 bottom-0 left-[15px] w-px bg-line-2 sm:left-[19px]" />}
      <span
        aria-hidden
        className="absolute top-0 left-0 flex size-8 items-center justify-center rounded-full border border-line-2 bg-panel font-display text-sm font-bold text-brand shadow-[inset_0_0_0_3px_var(--color-panel),inset_0_0_0_4px_var(--color-brand-soft)] sm:size-10 sm:text-base"
      >
        {n}
      </span>
      <div className="mb-4 flex min-h-8 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 sm:min-h-10">
        <h2 className="font-display text-xl font-semibold text-ink sm:text-2xl">{title}</h2>
        {meta && <span className="text-sm text-ink-3">{meta}</span>}
      </div>
      {children}
    </li>
  );
}

function Readout({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "up" | "down" }) {
  return (
    <div className="min-w-0 rounded-[14px] border border-line bg-panel px-4 py-3">
      <div className="text-2xs leading-snug text-ink-3 sm:truncate">{label}</div>
      <motion.div
        key={value}
        initial={{ opacity: 0.4, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className={`num mt-1 text-2xl font-semibold whitespace-nowrap max-[359px]:text-xl ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink"}`}
      >
        {value}
      </motion.div>
      {note && <div className="mt-0.5 text-2xs leading-snug text-ink-3 sm:truncate">{note}</div>}
    </div>
  );
}

/**
 * Leverage as a dial you drag: five stops on one track, the fill and the thumb
 * following. A native range underneath carries keyboard and screen readers.
 */
function LeverageDial({ value, onChange, max }: { value: number; onChange: (v: number) => void; max: number | null }) {
  const i = LEVERAGES.indexOf(value);
  const allowed = (l: number) => max == null || l <= max;
  const lastAllowed = LEVERAGES.reduce((k, l, idx) => (allowed(l) ? idx : k), 0);
  const pct = (i / (LEVERAGES.length - 1)) * 100;
  return (
    <div>
      <div className="flex items-end justify-between">
        <motion.span
          key={value}
          initial={{ scale: 0.85, opacity: 0.4 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 18 }}
          className="font-display text-6xl leading-none font-bold tracking-[-0.04em] text-ink"
        >
          {value}x
        </motion.span>
        <span className="pb-1 text-sm text-ink-3">
          {value >= 25 ? "full degen" : value >= 10 ? "maximum conviction" : value >= 5 ? "aggressive" : "steady"}
        </span>
      </div>
      <div className="relative mt-6 h-10">
        <div className="absolute top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-panel-2" />
        <motion.div
          className="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-step-3 to-brand"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        />
        {LEVERAGES.map((l, k) => (
          <button
            key={l}
            type="button"
            tabIndex={-1}
            onClick={() => allowed(l) && onChange(l)}
            className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel ${allowed(l) ? "bg-line-2" : "bg-down/40"}`}
            style={{ left: `${(k / (LEVERAGES.length - 1)) * 100}%` }}
            aria-hidden
          />
        ))}
        <motion.div
          className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-panel bg-brand shadow-[0_4px_14px_rgba(15,107,63,0.45)]"
          initial={false}
          animate={{ left: `${pct}%` }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        />
        <input
          type="range"
          min={0}
          max={LEVERAGES.length - 1}
          step={1}
          value={i}
          onChange={(e) => onChange(LEVERAGES[Math.min(Number(e.target.value), lastAllowed)])}
          aria-label="Leverage"
          aria-valuetext={`${value}x`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <div className="relative mt-1 h-5">
        {LEVERAGES.map((l, k) => (
          <span
            key={l}
            className={`num absolute text-xs ${k === 0 ? "" : k === LEVERAGES.length - 1 ? "-translate-x-full" : "-translate-x-1/2"} ${
              l === value ? "font-semibold text-brand" : allowed(l) ? "text-ink-3" : "text-ink-3/40 line-through"
            }`}
            style={{ left: `${(k / (LEVERAGES.length - 1)) * 100}%` }}
          >
            {l}x
          </span>
        ))}
      </div>
    </div>
  );
}

/** the anti-snipe schedule, drawn: the fee falling from the opening rate to the coin's fee */
function ProtectionCurve({ endPct }: { endPct: number }) {
  const start = SNIPE.startFee / 10_000;
  const W = 320;
  const H = 110;
  const y = (v: number) => 10 + (1 - v / start) * (H - 30);
  const xEnd = W * 0.62;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 h-auto w-full max-w-[420px]" aria-label={`Fee falls from ${start}% to ${endPct}% in ${SNIPE.seconds} seconds`}>
      <line x1="0" y1={H - 20} x2={W} y2={H - 20} stroke="var(--color-line-2)" />
      <motion.path
        d={`M0,${y(start)} L${xEnd},${y(endPct)} L${W},${y(endPct)}`}
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth="2.5"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
      />
      <text x="4" y={y(start) - 2} className="fill-ink-2 text-[11px]">
        {start}% at second 0
      </text>
      <text x={xEnd + 6} y={y(endPct) - 6} className="fill-ink-2 text-[11px]">
        {endPct}% from second {SNIPE.seconds}
      </text>
      <text x="0" y={H - 4} className="fill-ink-3 text-[10px]">
        launch
      </text>
      <text x={xEnd} y={H - 4} textAnchor="middle" className="fill-ink-3 text-[10px]">
        {SNIPE.seconds}s
      </text>
    </svg>
  );
}

function LaunchPanel({
  predicted,
  simError,
  address,
  ready,
  mcapUsd,
  viaHub,
  enginePct,
  treasuryPct,
  feeSplit,
  withFirstBuy,
  symbol,
  launched,
  error,
  button,
}: {
  predicted: { asset: string; gas: ethers.BigNumber | null; firstBuyOut: ethers.BigNumber | null } | null;
  simError: string | null;
  address: string | null | undefined;
  ready: boolean;
  mcapUsd: number;
  viaHub: boolean;
  enginePct: number;
  treasuryPct: number;
  feeSplit: FeeSplit | null;
  withFirstBuy: boolean;
  symbol: string;
  launched: Launched | null;
  error: string | null;
  button: React.ReactNode;
}) {
  return (
    <div className="rounded-[18px] border border-line bg-panel p-5">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
        <dt className="text-ink-3">Token address</dt>
        <dd className="num min-w-0 truncate text-right text-ink">
          {predicted ? (
            <a className="underline underline-offset-2" href={explorerAddr(predicted.asset)} target="_blank" rel="noreferrer">
              {short(predicted.asset)}
            </a>
          ) : address && ready ? (
            simError ? <span className="text-down">{simError}</span> : "computing…"
          ) : (
            <span className="text-ink-3">name it to preview</span>
          )}
        </dd>
        <dt className="text-ink-3">Opens at</dt>
        <dd className="num text-right text-ink">~${mcapUsd.toFixed(0)} market cap</dd>
        <dt className="text-ink-3">Fees</dt>
        <dd className="min-w-0 truncate text-right text-ink">
          {viaHub ? (
            <>
              95% engine hub{" "}
              <a className="num text-ink-2 underline underline-offset-2" href={explorerAddr(LAUNCH_FEE_HUB)} target="_blank" rel="noreferrer">
                {short(LAUNCH_FEE_HUB)}
              </a>
            </>
          ) : (
            <>
              {enginePct}% engine, {treasuryPct}% protocol, 5% Doppler
              {feeSplit && (
                <>
                  {" "}
                  <a className="num text-ink-2 underline underline-offset-2" href={explorerAddr(feeSplit.sink)} target="_blank" rel="noreferrer">
                    sink
                  </a>
                </>
              )}
            </>
          )}
        </dd>
        {withFirstBuy && (
          <>
            <dt className="text-ink-3">First buy gets</dt>
            <dd className="num text-right text-ink">
              {predicted?.firstBuyOut
                ? `≈ ${Number(ethers.utils.formatEther(predicted.firstBuyOut)).toLocaleString("en-US", { maximumFractionDigits: 0 })} $${symbol || "TICKER"}`
                : "simulating…"}
            </dd>
          </>
        )}
        <dt className="text-ink-3">Gas</dt>
        <dd className="num text-right text-ink">
          {predicted?.gas ? `~${predicted.gas.toNumber().toLocaleString("en-US")} units` : "estimated at signing"}
        </dd>
      </dl>

      <div className="mt-5">{button}</div>

      {launched && (
        <div className="mt-4 rounded-xl bg-brand-soft px-4 py-3.5 text-sm leading-relaxed text-ink-2" role="status">
          <span className="font-semibold text-brand">${launched.symbol} is live.</span>{" "}
          <a className="font-medium text-brand underline underline-offset-2" href={`/token/${launched.asset}`}>
            Open its page
          </a>
          <span className="mt-1 flex flex-wrap gap-x-3 text-xs">
            <a className="underline underline-offset-2" href={explorerToken(launched.asset)} target="_blank" rel="noreferrer">
              token
            </a>
            <a className="underline underline-offset-2" href={dexscreenerPool(launched.poolId)} target="_blank" rel="noreferrer">
              DexScreener
            </a>
            <a className="underline underline-offset-2" href={explorerTx(launched.hash)} target="_blank" rel="noreferrer">
              transaction
            </a>
            <a className="underline underline-offset-2" href={launched.metadataUrl} target="_blank" rel="noreferrer">
              metadata
            </a>
          </span>
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm leading-relaxed text-down" role="alert">
          {error}
        </p>
      )}

      <p className="mt-4 text-xs leading-relaxed text-ink-3">
        You sign twice: once to pin the logo and metadata to IPFS (no gas), once for the launch. One transaction through the
        multiply router{" "}
        <a className="num underline underline-offset-2" href={explorerAddr(LAUNCH_ROUTER)} target="_blank" rel="noreferrer">
          {short(LAUNCH_ROUTER)}
        </a>{" "}
        deploys the token, seeds the pool and locks it. The lock is irreversible.
      </p>
    </div>
  );
}

const fmtMove = (pct: number) => `${pct.toFixed(pct < 10 ? 1 : 0)}%`;

/**
 * The take-profit as a slider from +10% up to what the leverage allows (20× the leverage,
 * +500% at most), with the old profiles as shortcuts and two numbers underneath: how far the
 * asset has to move for a deposit to bank, and how far the other way loses its fees.
 */
function TakeProfitSlider({
  value,
  max,
  onChange,
  market,
  leverage,
  up,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  market: string;
  leverage: number;
  up: boolean;
}) {
  const pct = max > TP_MIN_PCT ? ((value - TP_MIN_PCT) / (max - TP_MIN_PCT)) * 100 : 100;
  const need = value / leverage;
  const liqAway = 100 / leverage;
  const tone = value > 150 ? "text-down" : value <= 30 ? "text-up" : "text-brand";
  const band = value <= 30 ? "safe" : value <= 75 ? "balanced" : value <= 150 ? "degen" : "moon";
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <span className="num font-display text-6xl leading-none font-bold tracking-[-0.04em] text-ink">+{value}%</span>
        <span className={`pb-1 text-sm font-semibold capitalize ${tone}`}>{band}</span>
      </div>

      <div className="relative mt-6 h-10">
        <div className="absolute top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-up/25 via-brand/25 to-down/30" />
        <div
          className="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-up via-brand to-down"
          style={{ width: `${pct}%` }}
        />
        <div
          className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-panel bg-ink shadow-[0_4px_14px_rgba(12,52,32,0.4)]"
          style={{ left: `${pct}%` }}
        />
        <input
          type="range"
          min={TP_MIN_PCT}
          max={max}
          step={5}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Take-profit per deposit"
          aria-valuetext={`+${value}%`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {TP_PRESETS.map((p) => (
          <button
            key={p.pct}
            type="button"
            disabled={p.pct > max}
            onClick={() => onChange(p.pct)}
            className={`num rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              value === p.pct ? "border-brand bg-brand-soft font-semibold text-brand" : "border-line text-ink-2 hover:border-line-2"
            }`}
          >
            +{p.pct}% {p.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-ink-3">
          Up to <span className="num">+{max}%</span> at {leverage}x
        </span>
      </div>
      {max < TP_PRESETS[TP_PRESETS.length - 1].pct && (
        <p className="mt-2 text-xs text-ink-3">
          A target stays within a {TP_MOVE_MAX_PCT}% move of the asset, so it can actually be reached. More leverage, higher
          targets.
        </p>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Readout
          tone="up"
          label={`Takes profit when ${market} moves`}
          value={`${fmtMove(need)} ${up ? "up" : "down"}`}
          note="from each deposit's entry"
        />
        <Readout
          tone="up"
          label="At take-profit the fees become"
          value={`×${(1 + value / 100).toFixed(2).replace(/\.?0+$/, "")}`}
          note="each deposit, when it banks"
        />
        <div className="col-span-2 sm:col-span-1">
          <Readout
            tone="down"
            label={`Fees lost if ${market} moves`}
            value={`~${fmtMove(liqAway)} ${up ? "down" : "up"}`}
            note="liquidation: the fees, nothing more"
          />
        </div>
      </div>
    </div>
  );
}

/** the side change, as a flood of the new side's ink from the click, gone in under a second */
function SideWash({ wash }: { wash: { x: number; y: number; to: "long" | "short"; id: number } | null }) {
  const reduced = useReducedMotion();
  if (!wash || reduced) return null;
  const colour = wash.to === "short" ? "rgba(179,38,30,0.14)" : "rgba(15,107,63,0.14)";
  return (
    <motion.div
      key={wash.id}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[55]"
      style={{ background: colour }}
      initial={{ clipPath: `circle(0px at ${wash.x}px ${wash.y}px)`, opacity: 1 }}
      animate={{ clipPath: `circle(150% at ${wash.x}px ${wash.y}px)`, opacity: 0 }}
      transition={{ clipPath: { duration: 0.7, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.9, ease: "easeIn" } }}
    />
  );
}

/**
 * The coin's logo: the creator's upload, or the seal generated from its settings when there is
 * none. The file never leaves the browser until the metadata is pinned at launch.
 */
function LogoPicker({
  logo,
  error,
  onPick,
  onClear,
  fallback,
}: {
  logo: Logo | null;
  error: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
  fallback: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block text-xs text-ink-3">Logo, optional</span>
      <div className="flex items-start gap-3 sm:block">
        <label className="group relative flex size-[112px] shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-[14px] border border-dashed border-line-2 bg-panel transition-colors hover:border-brand/50">
          <input
            type="file"
            accept={LOGO_TYPES.join(",")}
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
              e.target.value = "";
            }}
          />
          {logo ? (
            // a data: URL from the user's own file; next/image has nothing to optimise here
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo.dataUrl} alt="" className="size-full object-cover" />
          ) : (
            <span className="pointer-events-none opacity-60 transition-opacity group-hover:opacity-30">{fallback}</span>
          )}
          <span
            className={cn(
              "absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-ink/70 py-1 text-2xs font-medium text-white transition-opacity",
              logo ? "opacity-0 group-hover:opacity-100" : "opacity-100"
            )}
          >
            <ImagePlus size={12} aria-hidden />
            {logo ? "Replace" : "Upload"}
          </span>
        </label>
        <div className="min-w-0 pt-1 text-2xs leading-relaxed text-ink-3 sm:mt-2 sm:pt-0">
          {logo ? (
            <button type="button" onClick={onClear} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
              <X size={11} aria-hidden /> Use the seal
            </button>
          ) : (
            <span className="sm:hidden">Square, under 1 MB. Without one, the coin uses its seal.</span>
          )}
          {error && (
            <span className="mt-1 block text-down" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
