"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import type { CoinDetail } from "@/lib/types";
import { PUBLIC_RPC, USDG, NATIVE, MULTICALL3, DOPPLER, UNIVERSAL_ROUTER, PERMIT2, explorerTx } from "@/lib/clientConfig";
import { NoRoute, quoteRoute, swapRoute } from "@/lib/swap";
import { TICK_SPACING, DYNAMIC_FEE_FLAG } from "@/lib/doppler";
import { multicall } from "@/lib/multicall";
import { sendGuardedTx, waitForReceipt, txErrorMessage } from "@/lib/tx";
import { useWallet, ChainGate } from "@/components/wallet";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { AnimatePresence, motion } from "motion/react";

/**
 * USDG ⇄ coin on the coin's Uniswap v4 pool, through the Universal Router.
 *
 * The quote comes from Doppler's Quoter (the pool's own math, crossing ticks),
 * less the hook fee the pool is charging right now (`getFeeSchedule`: flat, or
 * still decaying after a protected launch). minOut is that less 1% slippage.
 * Robinhood Chain has no public mempool, so that is not sandwich protection;
 * it protects from price movement and from a venue that executes badly.
 *
 * v4 routes through Permit2: the token is approved to Permit2 once (max), then
 * Permit2 grants the router a bounded, expiring allowance. Two approvals the
 * first time, none afterwards until the allowance runs out.
 *
 * Nothing here builds a signer. Reads go to the public RPC in one batched call;
 * writes go through `sendGuardedTx`, which refuses to sign on another chain.
 */

const BN = ethers.BigNumber.from;
const MAX128 = BN(2).pow(128);
const SLIPPAGE_BPS = 100;
const MIN_SQRT = BN("4295128740");
const MAX_SQRT = BN("1461446703485210103287273052203988822378723970341");
const PERMIT2_EXPIRY_S = 30 * 24 * 3600;

const ERC20_IFACE = new ethers.utils.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const PERMIT2_IFACE = new ethers.utils.Interface([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);
const QUOTER_IFACE = new ethers.utils.Interface([
  "function quoteSingle((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params) view returns (int256 amount0,int256 amount1,uint160 sqrtPriceAfter,uint32 initializedTicksCrossed)",
]);
const REHYPE_IFACE = new ethers.utils.Interface([
  "function getFeeSchedule(bytes32) view returns (uint32 startingTime,uint24 startFee,uint24 endFee,uint24 lastFee,uint32 durationSeconds)",
]);
const UR_IFACE = new ethers.utils.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const QUOTER = "0xce6cd4e35447e05a39a50a4bcf61f2dcd93a8f0d";

const readProvider = new ethers.providers.StaticJsonRpcProvider(PUBLIC_RPC, { chainId: 4663, name: "robinhood" });

type Account = { eth: ethers.BigNumber; quote: ethers.BigNumber; coin: ethers.BigNumber; erc20ToPermit2: ethers.BigNumber; permit2ToRouter: ethers.BigNumber; permit2Expiry: number; checkedAt: number };
/** `viaEth` quotes are KyberSwap's and end in its router; the others are ours, straight to the pool */
type Quote = { amountIn: ethers.BigNumber; out: ethers.BigNumber; minOut: ethers.BigNumber; hookFee: number; viaEth: boolean; dir: "buy" | "sell" };
/** ETH left for gas when someone presses max */
const GAS_RESERVE = ethers.utils.parseEther("0.0003");
const MULTICALL_IFACE = new ethers.utils.Interface(["function getEthBalance(address) view returns (uint256)"]);

export default function SwapPanel({ detail }: { detail: CoinDetail }) {
  const { coin, demo, poolRaw } = detail;
  const { address: account, provider } = useWallet();
  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [txDone, setTxDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAcct, setLoadedAcct] = useState<Account | null>(null);
  const [quoteOn, setQuoted] = useState<Quote | null>(null);
  /** what is paid for a buy and received for a sell; null until chosen, then the wallet's own money decides */
  const [moneyPick, setMoney] = useState<"ETH" | "USDG" | null>(null);
  const [noRoute, setNoRoute] = useState(false);

  const acct = account ? loadedAcct : null;
  // a wallet with ETH and no USDG starts on ETH
  const money = moneyPick ?? (acct && acct.quote.lt(ethers.utils.parseUnits("1", 6)) && acct.eth.gt(GAS_RESERVE) ? "ETH" : "USDG");
  const viaEth = money === "ETH";
  const moneyDec = viaEth ? 18 : coin.pairDecimals;
  const moneySym = viaEth ? "ETH" : coin.pairSymbol;
  const inDec = dir === "buy" ? moneyDec : 18;
  const outDec = dir === "buy" ? 18 : moneyDec;
  const inSym = dir === "buy" ? moneySym : coin.symbol;
  const outSym = dir === "buy" ? coin.symbol : moneySym;
  // a quote made for the other money or the other side is not a quote
  const quoted = quoteOn && quoteOn.viaEth === viaEth && quoteOn.dir === dir ? quoteOn : null;
  const tokenIn = dir === "buy" ? coin.pair : coin.token;
  const tokenOut = dir === "buy" ? coin.token : coin.pair;
  const coinIs0 = BN(coin.token).lt(BN(USDG));
  const poolKey = useMemo(
    () => ({
      currency0: coinIs0 ? coin.token : USDG,
      currency1: coinIs0 ? USDG : coin.token,
      fee: DYNAMIC_FEE_FLAG,
      tickSpacing: TICK_SPACING,
      hooks: DOPPLER.hookInitializer,
    }),
    [coin.token, coinIs0]
  );
  const zeroForOne = dir === "buy" ? !coinIs0 : coinIs0;

  const amountIn = useMemo(() => {
    if (!amount || Number(amount) <= 0) return null;
    try {
      const v = ethers.utils.parseUnits(amount, inDec);
      return v.gte(MAX128) ? null : v;
    } catch {
      return null;
    }
  }, [amount, inDec]);

  /*
   * The quote is an RPC read that depends on the amount: an effect is the right
   * tool, and the `live` flag drops answers to superseded inputs.
   */
  useEffect(() => {
    if (!amountIn || !poolRaw) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuoted(null);
      return;
    }
    let live = true;
    const stop = new AbortController();
    // an aggregator's route lives seconds: it is asked again while it is on screen
    let again: ReturnType<typeof setInterval> | undefined;
    const feeOf = (s: { startFee: number; endFee: number; startingTime: number; durationSeconds: number } | null | undefined) => {
      if (!s) return coin.fee;
      if (Number(s.startFee) === Number(s.endFee) || Number(s.durationSeconds) === 0) return Number(s.endFee);
      const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - Number(s.startingTime));
      return elapsed >= Number(s.durationSeconds)
        ? Number(s.endFee)
        : Number(s.startFee) - Math.floor(((Number(s.startFee) - Number(s.endFee)) * elapsed) / Number(s.durationSeconds));
    };
    const viaKyber = async () => {
      try {
        const [route, [s]] = await Promise.all([
          quoteRoute(dir === "buy" ? NATIVE : coin.token, dir === "buy" ? coin.token : NATIVE, amountIn, stop.signal),
          multicall(readProvider, [{ target: DOPPLER.rehype, iface: REHYPE_IFACE, fn: "getFeeSchedule", args: [coin.poolId] }]).catch(() => [null]),
        ]);
        const out = BN(route.routeSummary.amountOut);
        if (!live) return;
        setNoRoute(false);
        setQuoted({ amountIn, out, minOut: out.mul(10_000 - SLIPPAGE_BPS).div(10_000), hookFee: feeOf(s as never), viaEth: true, dir });
      } catch (e) {
        if (!live) return;
        setNoRoute(e instanceof NoRoute);
        setQuoted(null);
      }
    };
    const t = setTimeout(async () => {
      if (viaEth) {
        await viaKyber();
        if (live) again = setInterval(() => !document.hidden && void viaKyber(), 8_000);
        return;
      }
      try {
        const [q, s] = await multicall(readProvider, [
          { target: QUOTER, iface: QUOTER_IFACE, fn: "quoteSingle", args: [poolKey, { zeroForOne, amountSpecified: amountIn.mul(-1), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT.add(1) : MAX_SQRT.sub(1) }] },
          { target: DOPPLER.rehype, iface: REHYPE_IFACE, fn: "getFeeSchedule", args: [coin.poolId] },
        ]);
        if (!q) throw new Error("no quote");
        const gross: ethers.BigNumber = (zeroForOne ? q.amount1 : q.amount0).abs();
        const hookFee = feeOf(s as never);
        const out = gross.mul(1_000_000 - hookFee).div(1_000_000);
        if (live) setQuoted({ amountIn, out, minOut: out.mul(10_000 - SLIPPAGE_BPS).div(10_000), hookFee, viaEth: false, dir });
      } catch {
        if (live) setQuoted(null);
      }
    }, 250);
    return () => {
      live = false;
      stop.abort();
      clearTimeout(t);
      clearInterval(again);
    };
  }, [amountIn, poolRaw, poolKey, zeroForOne, coin.poolId, coin.fee, coin.token, viaEth, dir]);

  /** balances and both allowance hops in one request */
  const refresh = useCallback(
    async (addr: string) => {
      const [q, c, a, p, e] = await multicall(readProvider, [
        { target: coin.pair, iface: ERC20_IFACE, fn: "balanceOf", args: [addr] },
        { target: coin.token, iface: ERC20_IFACE, fn: "balanceOf", args: [addr] },
        { target: tokenIn, iface: ERC20_IFACE, fn: "allowance", args: [addr, PERMIT2] },
        { target: PERMIT2, iface: PERMIT2_IFACE, fn: "allowance", args: [addr, tokenIn, UNIVERSAL_ROUTER] },
        { target: MULTICALL3, iface: MULTICALL_IFACE, fn: "getEthBalance", args: [addr] },
      ]);
      setLoadedAcct({
        eth: e ? e[0] : BN(0),
        quote: q ? q[0] : BN(0),
        coin: c ? c[0] : BN(0),
        erc20ToPermit2: a ? a[0] : BN(0),
        permit2ToRouter: p ? BN(p.amount) : BN(0),
        permit2Expiry: p ? Number(p.expiration) : 0,
        checkedAt: Math.floor(Date.now() / 1000), // read once here so the render stays pure
      });
    },
    [coin.pair, coin.token, tokenIn]
  );

  useEffect(() => {
    if (!account) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh(account).catch(() => {});
  }, [account, refresh]);

  const balanceIn = acct ? (dir === "buy" ? (viaEth ? acct.eth : acct.quote) : acct.coin) : null;
  const maxIn = balanceIn && dir === "buy" && viaEth ? (balanceIn.gt(GAS_RESERVE) ? balanceIn.sub(GAS_RESERVE) : BN(0)) : balanceIn;
  const insufficient = !!(quoted && maxIn && quoted.amountIn.gt(maxIn));
  const needsErc20Approval = !!(quoted && !viaEth && acct && acct.erc20ToPermit2.lt(quoted.amountIn));
  // an allowance that expires within the hour is treated as spent: the swap is not instant
  const needsPermit2 = !!(quoted && !viaEth && acct && (acct.permit2ToRouter.lt(quoted.amountIn) || acct.permit2Expiry <= acct.checkedAt + 3600));
  const needsApproval = needsErc20Approval || needsPermit2;

  async function swap() {
    if (!quoted || !account || !provider) return;
    setError(null);
    setTxDone(null);
    try {
      if (quoted.viaEth) {
        const hash = await swapRoute({
          provider,
          read: readProvider,
          account,
          tokenIn: dir === "buy" ? NATIVE : coin.token,
          tokenOut: dir === "buy" ? coin.token : NATIVE,
          amountIn: quoted.amountIn,
          shownOut: quoted.out,
          slippageBps: SLIPPAGE_BPS,
          onStep: (w) => setBusy(w === "approve" ? `Approving ${inSym}` : "Swapping"),
        });
        setTxDone(hash);
        setAmount("");
        refresh(account).catch(() => {});
        return;
      }
      if (needsErc20Approval) {
        setBusy(`Approving ${inSym}`);
        const h = await sendGuardedTx(provider, { from: account, to: tokenIn, data: ERC20_IFACE.encodeFunctionData("approve", [PERMIT2, ethers.constants.MaxUint256]) });
        if ((await waitForReceipt(h)).status !== "success") throw new Error("The approval reverted.");
      }
      if (needsPermit2) {
        setBusy("Allowing the router");
        const h = await sendGuardedTx(provider, {
          from: account,
          to: PERMIT2,
          data: PERMIT2_IFACE.encodeFunctionData("approve", [tokenIn, UNIVERSAL_ROUTER, quoted.amountIn, Math.floor(Date.now() / 1000) + PERMIT2_EXPIRY_S]),
        });
        if ((await waitForReceipt(h)).status !== "success") throw new Error("The router allowance reverted.");
      }
      setBusy("Swapping");
      const coder = ethers.utils.defaultAbiCoder;
      const actions = ethers.utils.solidityPack(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
      const params = [
        coder.encode(
          ["tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)"],
          [{ poolKey: [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn: quoted.amountIn, amountOutMinimum: quoted.minOut, minHopPriceX36: 0, hookData: "0x" }]
        ),
        coder.encode(["address", "uint256"], [tokenIn, quoted.amountIn]),
        coder.encode(["address", "uint256"], [tokenOut, quoted.minOut]),
      ];
      const inputs = [coder.encode(["bytes", "bytes[]"], [actions, params])];
      const hash = await sendGuardedTx(provider, {
        from: account,
        to: UNIVERSAL_ROUTER,
        data: UR_IFACE.encodeFunctionData("execute", ["0x10", inputs, Math.floor(Date.now() / 1000) + 600]),
      });
      const rc = await waitForReceipt(hash);
      if (rc.status !== "success") throw new Error("The swap reverted, try a smaller size.");
      setTxDone(hash);
      setAmount("");
      refresh(account).catch(() => {});
    } catch (err) {
      setError(txErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const pickMoney = (m: "ETH" | "USDG") => {
    setMoney(m);
    setNoRoute(false);
    setError(null);
    // an amount of ETH is not an amount of USDG
    if (dir === "buy") setAmount("");
  };

  const tradingOff = demo || !poolRaw;
  const fmtUnits = (v: ethers.BigNumber, dec: number, max = 4) =>
    Number(ethers.utils.formatUnits(v, dec)).toLocaleString("en-US", { maximumFractionDigits: max });

  return (
    <Panel>
      <div className="flex flex-col gap-3 p-4">
        <div role="radiogroup" aria-label="Trade direction" className="relative grid grid-cols-2 gap-1 rounded-lg bg-void p-1">
          {(["buy", "sell"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={dir === d}
              onClick={() => {
                setDir(d);
                setTxDone(null);
                setError(null);
              }}
              className={`relative z-10 min-w-0 rounded-md px-3 py-2 text-sm font-semibold capitalize transition-colors ${dir === d ? "text-white" : "text-ink-3 hover:text-ink-2"}`}
            >
              {dir === d && (
                <motion.span layoutId="swap-direction" className={`absolute inset-0 -z-10 rounded-md ${d === "buy" ? "bg-brand" : "bg-down"}`} transition={{ type: "spring", stiffness: 420, damping: 34 }} />
              )}
              <span className="truncate">
                {d} {coin.symbol}
              </span>
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-border bg-void px-3.5 py-3 transition-colors focus-within:border-brand">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-ink-3">You pay</span>
            {balanceIn && (
              <button type="button" className="min-w-0 truncate text-xs text-ink-3 transition-colors hover:text-brand" onClick={() => setAmount(ethers.utils.formatUnits(maxIn ?? balanceIn, inDec))}>
                Balance {fmtUnits(balanceIn, inDec, viaEth && dir === "buy" ? 5 : 2)}, max
              </button>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <input
              value={amount}
              onChange={(ev) => setAmount(ev.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.00"
              inputMode="decimal"
              disabled={tradingOff}
              aria-label={`Amount in ${inSym}`}
              className="num w-full min-w-0 bg-transparent text-2xl text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50"
            />
            {dir === "buy" ? <MoneyPick value={money} onChange={pickMoney} /> : <span className="shrink-0 text-sm text-ink-2">{inSym}</span>}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-void px-3.5 py-3">
          <span className="text-xs text-ink-3">You receive (est.)</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num w-full min-w-0 truncate text-2xl text-ink">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={quoted ? fmtUnits(quoted.out, outDec) : "empty"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }} className="inline-block">
                  {quoted ? fmtUnits(quoted.out, outDec, outDec === 18 && dir === "sell" ? 6 : 4) : "-"}
                </motion.span>
              </AnimatePresence>
            </span>
            {dir === "sell" ? <MoneyPick value={money} onChange={pickMoney} /> : <span className="shrink-0 text-sm text-ink-2">{outSym}</span>}
          </div>
          {quoted && (
            <div className="mt-1.5 text-xs text-ink-3">
              Min received {fmtUnits(quoted.minOut, outDec, outDec === 18 && dir === "sell" ? 6 : 4)} · fee now {quoted.hookFee / 10000}% · slippage 1%
            </div>
          )}
        </div>

        {tradingOff ? (
          <Button size="xl" className="w-full" disabled>
            {demo ? "Demo token, trading off" : "Pool unreachable"}
          </Button>
        ) : (
          <ChainGate connectLabel="Connect wallet to trade">
            <Button size="xl" className="w-full" onClick={swap} disabled={!quoted || !!busy || insufficient}>
              {busy && <Spinner data-icon="inline-start" />}
              {busy ?? (insufficient ? `Not enough ${inSym}` : needsApproval ? `Approve and swap ${inSym}` : `Swap ${inSym} → ${outSym}`)}
            </Button>
          </ChainGate>
        )}

        {viaEth && noRoute && amountIn && (
          <p className="text-xs leading-relaxed text-ink-3">
            No ETH route for this token yet: a new pool takes a few seconds to be found.{" "}
            <button type="button" className="font-medium text-brand hover:underline" onClick={() => pickMoney("USDG")}>
              Use USDG
            </button>
          </p>
        )}

        {txDone && (
          <p className="text-xs text-up">
            Swapped ·{" "}
            <a className="underline underline-offset-2" href={explorerTx(txDone)} target="_blank" rel="noreferrer">
              view transaction
            </a>
          </p>
        )}
        {error && (
          <p className="text-xs leading-relaxed text-down" role="alert">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

/** the money side of the trade: ETH through KyberSwap, or USDG straight to the pool */
function MoneyPick({ value, onChange }: { value: "ETH" | "USDG"; onChange: (v: "ETH" | "USDG") => void }) {
  return (
    <span role="radiogroup" aria-label="Pay or receive in" className="flex shrink-0 rounded-md bg-panel p-0.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      {(["ETH", "USDG"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={`rounded px-2 py-1 text-xs font-semibold transition-colors ${value === m ? "bg-brand-soft text-brand" : "text-ink-3 hover:text-ink"}`}
        >
          {m}
        </button>
      ))}
    </span>
  );
}
