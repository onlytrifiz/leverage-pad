import Link from "next/link";
import { listCoins, openPositions } from "@/lib/detail";
import { fmtUsd, fmtInt } from "@/lib/format";
import { Container, PageHeader } from "@/components/ui/container";
import { StatGrid, Stat } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { DemoBadge } from "@/components/Badge";
import AutoRefresh from "@/components/AutoRefresh";
import { Reveal, RevealItem } from "@/components/motion";

export const metadata = { title: "Stats" };
export const dynamic = "force-dynamic";

const COLUMNS = "grid-cols-[1.4fr_1.2fr_1fr_1fr_1fr_1fr]";

export default async function StatsPage() {
  const [coins, positions] = await Promise.all([listCoins(), openPositions()]);
  const totalFees = coins.reduce((a, c) => a + c.feesCollectedUsd, 0);
  const totalBurned = coins.reduce((a, c) => a + c.burnedTokens, 0);
  const totalMcap = coins.reduce((a, c) => a + (c.marketCapUsd ?? 0), 0);
  const totalNotional = positions.reduce((a, p) => a + (p.notionalUsd ?? 0), 0);
  const totalPnl = positions.reduce((a, p) => a + (p.pnlUsd ?? 0), 0);
  const isDemo = coins.some((c) => c.demo);

  return (
    <Container className="pt-8">
      <PageHeader
        title="Protocol stats"
        lede="Every coin launched, what its engine is holding, and what it has burned so far."
        aside={
          <span className="flex items-center gap-3">
            <AutoRefresh everyMs={30_000} />
            {isDemo && <DemoBadge />}
          </span>
        }
      />

      <StatGrid cols={6} className="mt-7">
        <Stat label="Coins launched" amount={coins.length} format="plain" countOnMount />
        <Stat label="Combined mcap" amount={totalMcap} format="usd" countOnMount />
        <Stat label="Fees collected" amount={totalFees} format="usd" countOnMount />
        <Stat label="Tokens burned" amount={totalBurned} format="int" countOnMount tone="brand" />
        <Stat label="Open notional" amount={totalNotional} format="usd" countOnMount />
        <Stat
          label="Unrealized PnL"
          amount={totalPnl}
          format="signedUsd"
          countOnMount
          tone={totalPnl >= 0 ? "up" : "down"}
        />
      </StatGrid>

      {/* header row: only where the grid exists */}
      <div className={`mt-8 hidden gap-3 px-5 pb-2 md:grid ${COLUMNS}`}>
        {["Coin", "Underlying", "Market cap", "Fees", "Burned", "Engine"].map((h) => (
          <span key={h} className="text-xs font-medium text-ink-3">
            {h}
          </span>
        ))}
      </div>

      <Reveal as="ul" className="mt-4 flex flex-col gap-2 md:mt-0">
        {coins.map(({ coin, marketCapUsd, feesCollectedUsd, burnedTokens, perpOpen }) => (
          <RevealItem as="li" key={coin.token}>
            <Link
              href={`/token/${coin.token}`}
              className={`block rounded-[14px] border border-border bg-card px-4 py-4 shadow-[0_1px_2px_rgba(12,52,32,0.04)] transition-[color,background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[0_6px_18px_-8px_rgba(12,52,32,0.28)] sm:px-5 md:grid md:items-center md:gap-3 ${COLUMNS}`}
            >
              <div className="flex min-w-0 items-center justify-between gap-3 md:block">
                <span className="truncate text-md font-semibold text-ink">${coin.symbol}</span>
                <span className="num shrink-0 text-md font-semibold text-ink md:hidden">
                  {fmtUsd(marketCapUsd)}
                </span>
              </div>

              <span
                className={`mt-2 block truncate text-sm font-medium md:mt-0 ${
                  coin.side === "long" ? "text-up" : "text-down"
                }`}
              >
                {coin.leverage}× {coin.side} {coin.market}
              </span>

              <span className="num hidden truncate text-sm text-ink md:block">
                {fmtUsd(marketCapUsd)}
              </span>

              {/* on a phone the three remaining figures read as one labelled line */}
              <span className="num mt-2 flex flex-wrap gap-x-4 text-sm text-ink-3 md:hidden">
                <span>
                  Fees <span className="text-ink">{fmtUsd(feesCollectedUsd)}</span>
                </span>
                <span>
                  Burned <span className="text-brand">{fmtInt(burnedTokens)}</span>
                </span>
              </span>
              <span className="num hidden truncate text-sm text-ink md:block">
                {fmtUsd(feesCollectedUsd)}
              </span>
              <span className="num hidden truncate text-sm text-brand md:block">
                {fmtInt(burnedTokens)}
              </span>

              <span className="mt-3 block md:mt-0">
                <Badge variant={perpOpen ? "brand" : "secondary"}>
                  {perpOpen ? "Perp live" : "Accumulating"}
                </Badge>
              </span>
            </Link>
          </RevealItem>
        ))}
      </Reveal>
    </Container>
  );
}
