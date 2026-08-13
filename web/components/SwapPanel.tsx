"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import type { CoinDetail } from "@/lib/types";
import { PUBLIC_RPC, SWAP_ROUTER, explorerTx } from "@/lib/clientConfig";
import { fmtUsd } from "@/lib/format";
import { useWallet, getEthereum, ensureChain } from "./wallet";

/**
 * Swap USDG⇄coin diretto su SwapRouter02, wallet injected. Il quote e' la
 * stessa forma chiusa del keeper (range one-sided → L costante): l'output
 * atteso tiene conto dell'impatto prezzo, minOut = quote − 1% di slippage.
 */

const BN = ethers.BigNumber.from;
const Q96 = BN(2).pow(96);
const MAX128 = BN(2).pow(128);
const SLIPPAGE_BPS = 100;

function quoteExactInV3(sqrtP: ethers.BigNumber, L: ethers.BigNumber, amountInNet: ethers.BigNumber, zeroForOne: boolean) {
  if (L.isZero()) return BN(0);
  if (zeroForOne) {
    const sqrtNext = L.mul(Q96).mul(sqrtP).div(L.mul(Q96).add(amountInNet.mul(sqrtP)));
    return L.mul(sqrtP.sub(sqrtNext)).div(Q96);
  }
  const sqrtNext = sqrtP.add(amountInNet.mul(Q96).div(L));
  return L.mul(Q96).mul(sqrtNext.sub(sqrtP)).div(sqrtNext.mul(sqrtP));
}

const routerIface = new ethers.utils.Interface([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

export default function SwapPanel({ detail }: { detail: CoinDetail }) {
  const { coin, demo, poolRaw } = detail;
  const { address: account, connect, connecting } = useWallet();
  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [txDone, setTxDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ quote: string; coin: string } | null>(null);

  const inDec = dir === "buy" ? coin.pairDecimals : 18;
  const outDec = dir === "buy" ? 18 : coin.pairDecimals;
  const inSym = dir === "buy" ? coin.pairSymbol : coin.symbol;
  const outSym = dir === "buy" ? coin.symbol : coin.pairSymbol;

  const quoted = useMemo(() => {
    if (!poolRaw || !amount || Number(amount) <= 0) return null;
    try {
      const amountIn = ethers.utils.parseUnits(amount, inDec);
      if (amountIn.gte(MAX128)) return null;
      const net = amountIn.mul(1_000_000 - coin.fee).div(1_000_000);
      const zeroForOne = dir === "buy" ? !poolRaw.coinIsToken0 : poolRaw.coinIsToken0;
      const out = quoteExactInV3(BN(poolRaw.sqrtPriceX96), BN(poolRaw.liquidity), net, zeroForOne);
      const minOut = out.mul(10_000 - SLIPPAGE_BPS).div(10_000);
      return { amountIn, out, minOut };
    } catch {
      return null;
    }
  }, [poolRaw, amount, dir, coin.fee, inDec]);

  const refreshBalances = useCallback(async (addr: string) => {
    const provider = new ethers.providers.StaticJsonRpcProvider(PUBLIC_RPC, { chainId: 4663, name: "robinhood" });
    const [q, c] = await Promise.allSettled([
      new ethers.Contract(coin.pair, ERC20_ABI, provider).balanceOf(addr),
      new ethers.Contract(coin.token, ERC20_ABI, provider).balanceOf(addr),
    ]);
    setBalances({
      quote: q.status === "fulfilled" ? ethers.utils.formatUnits(q.value, coin.pairDecimals) : "0",
      coin: c.status === "fulfilled" ? ethers.utils.formatUnits(c.value, 18) : "0",
    });
  }, [coin.pair, coin.token, coin.pairDecimals]);

  useEffect(() => {
    if (account) refreshBalances(account).catch(() => {});
    else setBalances(null);
  }, [account, refreshBalances]);

  async function swap() {
    if (!quoted || !account) return;
    setError(null);
    setTxDone(null);
    const e = getEthereum();
    if (!e) return;
    try {
      await ensureChain(e);
      const provider = new ethers.providers.Web3Provider(e as unknown as ethers.providers.ExternalProvider);
      const signer = provider.getSigner();
      const tokenIn = dir === "buy" ? coin.pair : coin.token;
      const tokenOut = dir === "buy" ? coin.token : coin.pair;
      const inC = new ethers.Contract(tokenIn, ERC20_ABI, signer);
      const allowance = await inC.allowance(account, SWAP_ROUTER);
      if (allowance.lt(quoted.amountIn)) {
        setBusy(`approving ${inSym}…`);
        const txA = await inC.approve(SWAP_ROUTER, ethers.constants.MaxUint256);
        await txA.wait();
      }
      setBusy("swapping…");
      const inner = routerIface.encodeFunctionData("exactInputSingle", [{
        tokenIn, tokenOut, fee: coin.fee, recipient: account,
        amountIn: quoted.amountIn, amountOutMinimum: quoted.minOut, sqrtPriceLimitX96: 0,
      }]);
      const data = routerIface.encodeFunctionData("multicall", [Math.floor(Date.now() / 1000) + 600, [inner]]);
      const tx = await signer.sendTransaction({ to: SWAP_ROUTER, data });
      const rc = await tx.wait();
      setTxDone(rc.transactionHash);
      setAmount("");
      refreshBalances(account).catch(() => {});
    } catch (err) {
      setError((err as Error).message?.slice(0, 140) || "Swap failed");
    } finally {
      setBusy(null);
    }
  }

  const tradingOff = demo || !poolRaw;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="lbl">trade</span>
        <span className="lbl">router02 · pool fee {coin.fee / 10000}%</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex gap-1 rounded-md border border-line bg-void p-1">
          {(["buy", "sell"] as const).map((d) => (
            <button
              key={d}
              onClick={() => { setDir(d); setTxDone(null); }}
              className={`flex-1 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
                dir === d
                  ? d === "buy" ? "bg-accent text-void" : "bg-down text-ink"
                  : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {d} {coin.symbol}
            </button>
          ))}
        </div>

        <div className="rounded-md border border-line bg-void px-3 py-2.5 transition-colors focus-within:border-accent/50">
          <div className="flex items-baseline justify-between">
            <span className="lbl">you pay</span>
            {balances && (
              <button
                className="lbl normal-case tracking-normal transition-colors hover:text-accent-bright"
                onClick={() => setAmount(dir === "buy" ? balances.quote : balances.coin)}
              >
                bal {Number(dir === "buy" ? balances.quote : balances.coin).toLocaleString("en-US", { maximumFractionDigits: 2 })} — max
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
              className="num w-full bg-transparent text-[18px] text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50"
            />
            <span className="text-[12px] text-ink-2">{inSym}</span>
          </div>
        </div>

        <div className="rounded-md border border-line bg-void px-3 py-2.5">
          <span className="lbl">you receive (est.)</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num w-full text-[18px] text-ink">
              {quoted
                ? Number(ethers.utils.formatUnits(quoted.out, outDec)).toLocaleString("en-US", { maximumFractionDigits: 4 })
                : "—"}
            </span>
            <span className="text-[12px] text-ink-2">{outSym}</span>
          </div>
          {quoted && (
            <div className="lbl mt-1.5 normal-case tracking-normal">
              min received {Number(ethers.utils.formatUnits(quoted.minOut, outDec)).toLocaleString("en-US", { maximumFractionDigits: 4 })} · slippage 1%
            </div>
          )}
        </div>

        {!account ? (
          <button onClick={connect} disabled={connecting} className="btn-primary">
            {connecting ? "connecting…" : "Connect wallet"}
          </button>
        ) : tradingOff ? (
          <button disabled className="btn-primary" title="Demo coin — launch a real coin to trade">
            {demo ? "demo coin — swap off" : "pool unreachable"}
          </button>
        ) : (
          <button onClick={swap} disabled={!quoted || !!busy} className="btn-primary">
            {busy ?? `Swap ${inSym} → ${outSym}`}
          </button>
        )}
        {demo && account && (
          <div className="lbl normal-case tracking-normal">
            wallet connected — this is the demo coin, swaps enable on real launches
          </div>
        )}

        {txDone && (
          <div className="text-[11px] text-up-bright">
            Swapped ·{" "}
            <a className="underline underline-offset-2" href={explorerTx(txDone)} target="_blank" rel="noreferrer">
              view tx
            </a>
          </div>
        )}
        {error && <div className="text-[11px] text-down-bright">{error}</div>}

        <div className="lbl normal-case tracking-normal">
          every trade pays {coin.fee / 10000}% into the engine: {fmtUsd(detail.stats.feesCollectedUsd)} collected so far
        </div>
      </div>
    </div>
  );
}
