"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import type { CoinDetail } from "@/lib/types";
import { PUBLIC_RPC, USDG, DOPPLER, UNIVERSAL_ROUTER, PERMIT2, V4_POOL_MANAGER, explorerTx } from "@/lib/clientConfig";
import { TICK_SPACING, DYNAMIC_FEE_FLAG } from "@/lib/doppler";
import { multicall } from "@/lib/multicall";
import { sendGuardedTx, waitForReceipt, txErrorMessage } from "@/lib/tx";
import { fmtUsd } from "@/lib/format";
import { useWallet, ChainGate } from "@/components/wallet";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, PanelTitle, PanelMeta } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { ArrowUpDown } from "@/components/animate-ui/icons/arrow-up-down";
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

type Account = { quote: ethers.BigNumber; coin: ethers.BigNumber; erc20ToPermit2: ethers.BigNumber; permit2ToRouter: ethers.BigNumber; permit2Expiry: number; checkedAt: number };
type Quote = { amountIn: ethers.BigNumber; out: ethers.BigNumber; minOut: ethers.BigNumber; hookFee: number };

export default function SwapPanel({ detail }: { detail: CoinDetail }) {
  const { coin, demo, poolRaw } = detail;
  const { address: account, provider } = useWallet();
  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [txDone, setTxDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAcct, setLoadedAcct] = useState<Account | null>(null);
  const [quoted, setQuoted] = useState<Quote | null>(null);

  const inDec = dir === "buy" ? coin.pairDecimals : 18;
  const outDec = dir === "buy" ? 18 : coin.pairDecimals;
  const inSym = dir === "buy" ? coin.pairSymbol : coin.symbol;
  const outSym = dir === "buy" ? coin.symbol : coin.pairSymbol;
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
    const t = setTimeout(async () => {
      try {
        const [q, s] = await multicall(readProvider, [
          { target: QUOTER, iface: QUOTER_IFACE, fn: "quoteSingle", args: [poolKey, { zeroForOne, amountSpecified: amountIn.mul(-1), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT.add(1) : MAX_SQRT.sub(1) }] },
          { target: DOPPLER.rehype, iface: REHYPE_IFACE, fn: "getFeeSchedule", args: [coin.poolId] },
        ]);
        if (!q) throw new Error("no quote");
        const gross: ethers.BigNumber = (zeroForOne ? q.amount1 : q.amount0).abs();
        let hookFee = s ? Number(s.endFee) : coin.fee;
        if (s && Number(s.startFee) !== Number(s.endFee) && Number(s.durationSeconds) > 0) {
          const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - Number(s.startingTime));
          hookFee = elapsed >= Number(s.durationSeconds) ? Number(s.endFee) : Number(s.startFee) - Math.floor(((Number(s.startFee) - Number(s.endFee)) * elapsed) / Number(s.durationSeconds));
        }
        const out = gross.mul(1_000_000 - hookFee).div(1_000_000);
        if (live) setQuoted({ amountIn, out, minOut: out.mul(10_000 - SLIPPAGE_BPS).div(10_000), hookFee });
      } catch {
        if (live) setQuoted(null);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [amountIn, poolRaw, poolKey, zeroForOne, coin.poolId, coin.fee]);

  /** balances and both allowance hops in one request */
  const refresh = useCallback(
    async (addr: string) => {
      const [q, c, a, p] = await multicall(readProvider, [
        { target: coin.pair, iface: ERC20_IFACE, fn: "balanceOf", args: [addr] },
        { target: coin.token, iface: ERC20_IFACE, fn: "balanceOf", args: [addr] },
        { target: tokenIn, iface: ERC20_IFACE, fn: "allowance", args: [addr, PERMIT2] },
        { target: PERMIT2, iface: PERMIT2_IFACE, fn: "allowance", args: [addr, tokenIn, UNIVERSAL_ROUTER] },
      ]);
      setLoadedAcct({
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

  const acct = account ? loadedAcct : null;
  const balanceIn = acct ? (dir === "buy" ? acct.quote : acct.coin) : null;
  const insufficient = !!(quoted && balanceIn && quoted.amountIn.gt(balanceIn));
  const needsErc20Approval = !!(quoted && acct && acct.erc20ToPermit2.lt(quoted.amountIn));
  // an allowance that expires within the hour is treated as spent: the swap is not instant
  const needsPermit2 = !!(quoted && acct && (acct.permit2ToRouter.lt(quoted.amountIn) || acct.permit2Expiry <= acct.checkedAt + 3600));
  const needsApproval = needsErc20Approval || needsPermit2;

  async function swap() {
    if (!quoted || !account || !provider) return;
    setError(null);
    setTxDone(null);
    try {
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

  const tradingOff = demo || !poolRaw;
  const fmtUnits = (v: ethers.BigNumber, dec: number, max = 4) =>
    Number(ethers.utils.formatUnits(v, dec)).toLocaleString("en-US", { maximumFractionDigits: max });

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle className="flex items-center gap-2">
          <ArrowUpDown key={dir} aria-hidden size={16} animate className="text-brand" />
          Trade
        </PanelTitle>
        <PanelMeta>Uniswap v4 · fee {coin.fee / 10000}%</PanelMeta>
      </PanelHeader>
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
              <button type="button" className="min-w-0 truncate text-xs text-ink-3 transition-colors hover:text-brand" onClick={() => setAmount(ethers.utils.formatUnits(balanceIn, inDec))}>
                Balance {fmtUnits(balanceIn, inDec, 2)}, max
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
            <span className="shrink-0 text-sm text-ink-2">{inSym}</span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-void px-3.5 py-3">
          <span className="text-xs text-ink-3">You receive (est.)</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num w-full min-w-0 truncate text-2xl text-ink">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={quoted ? fmtUnits(quoted.out, outDec) : "empty"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }} className="inline-block">
                  {quoted ? fmtUnits(quoted.out, outDec) : "-"}
                </motion.span>
              </AnimatePresence>
            </span>
            <span className="shrink-0 text-sm text-ink-2">{outSym}</span>
          </div>
          {quoted && (
            <div className="mt-1.5 text-xs text-ink-3">
              Min received {fmtUnits(quoted.minOut, outDec)} · fee now {quoted.hookFee / 10000}% · slippage 1%
            </div>
          )}
        </div>

        {tradingOff ? (
          <Button size="xl" className="w-full" disabled>
            {demo ? "Demo coin, trading off" : "Pool unreachable"}
          </Button>
        ) : (
          <ChainGate connectLabel="Connect wallet to trade">
            <Button size="xl" className="w-full" onClick={swap} disabled={!quoted || !!busy || insufficient}>
              {busy && <Spinner data-icon="inline-start" />}
              {busy ?? (insufficient ? `Not enough ${inSym}` : needsApproval ? `Approve and swap ${inSym}` : `Swap ${inSym} → ${outSym}`)}
            </Button>
          </ChainGate>
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

        <p className="text-xs leading-relaxed text-ink-3">
          Every trade pays {coin.fee / 10000}% into the engine, collected in USDG. {fmtUsd(detail.stats.feesCollectedUsd)} so far.
          Pool <span className="num">{coin.poolId.slice(0, 10)}…</span> on the v4 PoolManager{" "}
          <span className="num">{V4_POOL_MANAGER.slice(0, 6)}…</span>.
        </p>
      </div>
    </Panel>
  );
}
