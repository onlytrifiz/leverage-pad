import { FLYWHEEL, PROFIT_SPLIT_PCT } from "@/lib/doppler";
import { TRANCHE_INTERVAL_MIN, fmtEvery } from "@/lib/thresholds";
import type { CoinDetail } from "@/lib/types";
import Link from "next/link";
import { fmtSignedUsd, fmtUsd } from "@/lib/format";
import { AnimatedNumber, RevealBlock } from "@/components/motion";
import { closedTotals } from "@/components/token/ClosedTranches";

/** of a take-profit's gain, the part that ends up buying the platform token: its own buyback, and
 *  the protocol's share coming back through the platform buyback */
const GAIN_TO_BUYBACK = PROFIT_SPLIT_PCT.buyback / 100 + (PROFIT_SPLIT_PCT.treasury / 100) * (FLYWHEEL.buybackPct / 100);

/** what the platform token's engine holds now and what it would buy back if every tranche reached its target */
export function inPlay(detail: CoinDetail) {
  const inPositions = detail.tranches.reduce((s, t) => s + t.collateralUsd, 0);
  const goingIn = detail.stats.waitingUsd + detail.stats.idleUsd;
  const atTargets =
    detail.tranches.reduce((s, t) => s + t.collateralUsd * (1 + (t.takeProfitPct / 100) * GAIN_TO_BUYBACK), 0) +
    goingIn * (1 + (detail.coin.takeProfitPct / 100) * GAIN_TO_BUYBACK);
  return { inPositions, goingIn, atTargets, tranches: detail.tranches.length };
}

export default function InPlay({ detail }: { detail: CoinDetail }) {
  const { coin } = detail;
  const { inPositions, goingIn, atTargets, tranches } = inPlay(detail);
  const closed = closedTotals(detail.closed);
  const cards = [
    {
      k: "In positions",
      v: inPositions,
      note: tranches === 0 ? "no tranche open yet" : `collateral in ${tranches} ${tranches === 1 ? "tranche" : "tranches"} on Lighter`,
    },
    { k: "Going in next", v: goingIn, note: `fees waiting for the next tranches, one every ${fmtEvery(TRANCHE_INTERVAL_MIN)}` },
    {
      k: "Buys back at the targets",
      v: atTargets,
      hot: true,
      note: `if every tranche reaches its take-profit: its capital and ${PROFIT_SPLIT_PCT.buyback}% of the gain, plus the protocol's share through the platform buyback`,
    },
  ];

  return (
    <section className="mt-16 sm:mt-20">
      <RevealBlock className="max-w-[680px]">
        <h2 className="text-3xl leading-[1.1] font-bold tracking-[-0.03em] sm:text-4xl">In play right now.</h2>
        <p className="mt-3 max-w-[56ch] text-lg leading-relaxed text-ink-2">
          ${coin.symbol} runs its own engine: {coin.market} {coin.side}, {coin.leverage}x, take-profit +{coin.takeProfitPct}%. Every tranche
          that reaches its target buys ${coin.symbol} and burns it.
        </p>
      </RevealBlock>
      <dl className="mt-9 grid grid-cols-1 gap-4 md:grid-cols-3">
        {cards.map((c) => (
          <div
            key={c.k}
            className={`min-w-0 rounded-[18px] border p-5 sm:p-6 ${c.hot ? "border-brand/40 bg-brand/[0.06]" : "border-line bg-panel"}`}
          >
            <dt className="text-sm text-ink-3">{c.k}</dt>
            <dd className={`num mt-2 truncate text-4xl font-semibold tracking-[-0.02em] ${c.hot ? "text-brand" : "text-ink"}`}>
              {c.hot && <span className="mr-0.5 font-normal">~</span>}
              <AnimatedNumber value={c.v} format="usd" countOnMount />
            </dd>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">{c.note}</p>
          </div>
        ))}
      </dl>
      {closed.count > 0 && (
        <p className="mt-5 max-w-[80ch] text-base leading-relaxed text-ink-2">
          Closed so far: {closed.count} {closed.count === 1 ? "tranche" : "tranches"}
          {closed.tookProfit > 0 && (
            <>
              , {closed.tookProfit === closed.count ? "all" : closed.tookProfit} at the take-profit (
              <span className="num whitespace-nowrap text-brand">{fmtSignedUsd(closed.banked)}</span>)
            </>
          )}
          {closed.liquidated > 0 && (
            <>
              {closed.tookProfit > 0 ? " and " : ", "}
              {closed.liquidated === closed.count ? "all" : closed.liquidated} liquidated (
              <span className="num whitespace-nowrap text-down">−{fmtUsd(closed.lost)}</span>)
            </>
          )}
          .{" "}
          <Link href={`/token/${coin.token}`} className="text-brand underline underline-offset-2">
            Every tranche on the ${coin.symbol} page
          </Link>
        </p>
      )}
      <p className="mt-4 max-w-[80ch] text-sm leading-relaxed text-ink-3">
        An estimate at today&apos;s targets, not a promise. If the market goes the other way, a tranche can be liquidated and its margin
        is lost.
      </p>
    </section>
  );
}
