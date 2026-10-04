import Link from "next/link";
import { cn } from "cn";
import { listCoins, openPositions } from "@/lib/detail";
import type { CoinListItem, OpenPosition } from "@/lib/types";
import { fmtUsd, fmtInt } from "@/lib/format";
import { Container } from "@/components/ui/container";
import AutoRefresh from "@/components/AutoRefresh";
import AssetIcon from "@/components/AssetIcon";
import { AnimatedNumber, LivePulse, Reveal, RevealItem } from "@/components/motion";
import { Guilloche } from "@/components/brand/Guilloche";
import { Bar, BarGroup } from "@/components/stats/Bars";

export const metadata = { title: "Stats" };
export const dynamic = "force-dynamic";

/**
 * The protocol in numbers, read like a ledger.
 *
 * The night band carries the totals, with the burn as the headline because it
 * is the one figure every engine works toward. Below it, three readings of the
 * same coins: where the open positions point, who leads, and every coin line
 * by line.
 */

const LEDGER_COLS =
  "md:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_120px]";

export default async function StatsPage() {
  const [coins, positions] = await Promise.all([listCoins(), openPositions().catch(() => [] as OpenPosition[])]);
  const totalFees = coins.reduce((a, c) => a + c.feesCollectedUsd, 0);
  const totalBurned = coins.reduce((a, c) => a + c.burnedTokens, 0);
  const totalMcap = coins.reduce((a, c) => a + (c.marketCapUsd ?? 0), 0);
  const totalNotional = positions.reduce((a, p) => a + (p.notionalUsd ?? 0), 0);
  const totalPnl = positions.reduce((a, p) => a + (p.pnlUsd ?? 0), 0);
  const liveEngines = coins.filter((c) => c.perpOpen).length;
  const isDemo = coins.some((c) => c.demo);
  const ledger = [...coins].sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
  const maxBurned = Math.max(1, ...coins.map((c) => c.burnedTokens));

  const totals = [
    { k: "Coins", v: <AnimatedNumber value={coins.length} format="plain" countOnMount /> },
    { k: "Engines live", v: <AnimatedNumber value={liveEngines} format="plain" countOnMount /> },
    { k: "Fees put to work", v: <AnimatedNumber value={totalFees} format="usd" countOnMount /> },
    { k: "Combined market cap", v: <AnimatedNumber value={totalMcap} format="usd" countOnMount /> },
    { k: "Open notional", v: <AnimatedNumber value={totalNotional} format="usd" countOnMount /> },
    {
      k: "Unrealized PnL",
      v: <AnimatedNumber value={totalPnl} format="signedUsd" countOnMount />,
      tone: totalPnl > 0 ? "text-night-up" : totalPnl < 0 ? "text-night-down" : undefined,
    },
  ];

  return (
    <>
      <section className="intro-night relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]">
        <div aria-hidden className="pointer-events-none absolute top-[44%] left-[62%] -z-10 text-mint/[0.11]">
          <Guilloche teeth={31} reach={0.82} rings={4} size={900} spin={170} direction={-1} className="w-[120vw] max-w-[900px]" />
        </div>
        <div className="mx-auto w-full max-w-[1320px] px-4 pt-10 pb-10 sm:px-5 sm:pt-14 sm:pb-14">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-[clamp(44px,6vw,84px)] leading-[0.95] font-bold tracking-[-0.04em] text-night-ink">
              The <span className="type-engraved [--ink-c:var(--color-mint)]">ledger</span>
            </h1>
            {isDemo && (
              <span className="rounded-full border border-night-line px-2.5 py-0.5 text-xs text-night-ink-2">Demo data</span>
            )}
          </div>
          <p className="mt-3 max-w-[50ch] text-lg text-night-ink-2">
            Every coin launched, what its engine is holding, and what it has burned so far.
          </p>

          <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-end">
            <div className="min-w-0">
              <div className="text-xs tracking-wide text-night-ink-2">Tokens burned, all coins</div>
              <div className="num mt-2 truncate text-[clamp(52px,9vw,112px)] leading-none font-semibold tracking-[-0.03em] text-mint">
                <AnimatedNumber value={totalBurned} format="int" countOnMount />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-5 border-t border-night-line pt-6 sm:grid-cols-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10">
              {totals.map((s) => (
                <div key={s.k} className="min-w-0">
                  <dt className="text-xs text-night-ink-2">{s.k}</dt>
                  <dd className={cn("num mt-1 truncate text-2xl font-semibold text-night-ink", s.tone)}>{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <Container width="landing" className="pb-10">
        <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Exposure positions={positions} />
          <Leaders coins={coins} />
        </div>

        <section className="mt-16">
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-display text-2xl font-semibold">Every coin</h2>
            <AutoRefresh everyMs={30_000} />
          </div>

          <div className={cn("hidden gap-4 border-b border-line px-5 pb-3 md:grid", LEDGER_COLS)}>
            {["#", "Coin", "Engine", "Market cap", "Fees", "Burned", "Status"].map((h) => (
              <span key={h} className="text-xs font-medium text-ink-3">
                {h}
              </span>
            ))}
          </div>

          {ledger.length === 0 ? (
            <p className="rounded-[18px] border border-dashed border-line-2 px-6 py-10 text-center text-ink-3">
              No coins yet.{" "}
              <Link href="/launch" className="font-medium text-brand underline underline-offset-2">
                Launch the first one
              </Link>
              .
            </p>
          ) : (
            // each row is a variant parent, so its burn bar grows as the row reveals
            <Reveal as="ul" className="mt-3 flex flex-col gap-2 md:mt-0 md:gap-0">
              {ledger.map((row, i) => (
                <RevealItem as="li" key={row.coin.token}>
                  <LedgerRow row={row} rank={i + 1} burnedFrac={row.burnedTokens / maxBurned} />
                </RevealItem>
              ))}
            </Reveal>
          )}
        </section>
      </Container>
    </>
  );
}

function LedgerRow({ row, rank, burnedFrac }: { row: CoinListItem; rank: number; burnedFrac: number }) {
  const { coin, marketCapUsd, feesCollectedUsd, burnedTokens, perpOpen } = row;
  const long = coin.side === "long";
  return (
    <Link
      href={`/token/${coin.token}`}
      className={cn(
        "group block rounded-[14px] border border-border bg-card px-4 py-4 transition-colors hover:border-brand/40",
        "md:grid md:items-center md:gap-4 md:rounded-none md:border-x-0 md:border-t-0 md:border-b-line md:bg-transparent md:px-5 md:hover:bg-panel",
        LEDGER_COLS
      )}
    >
      <span className="num hidden text-sm text-ink-3 md:block">{rank}</span>

      <div className="flex min-w-0 items-baseline justify-between gap-3 md:block">
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink group-hover:text-brand">${coin.symbol}</div>
          <div className="truncate text-xs text-ink-3">{coin.name}</div>
        </div>
        <span className="num shrink-0 font-semibold text-ink md:hidden">{fmtUsd(marketCapUsd)}</span>
      </div>

      <span className="mt-2 flex min-w-0 items-center gap-2 text-sm md:mt-0">
        <AssetIcon symbol={coin.market} size={18} />
        <span className={cn("truncate font-medium", long ? "text-up" : "text-down")}>
          {coin.leverage}× {coin.side} {coin.market}
        </span>
      </span>

      <span className="num hidden truncate text-sm text-ink md:block">{fmtUsd(marketCapUsd)}</span>

      <span className="num mt-2 flex flex-wrap gap-x-4 text-sm text-ink-3 md:hidden">
        <span>
          Fees <span className="text-ink">{fmtUsd(feesCollectedUsd)}</span>
        </span>
        <span>
          Burned <span className="text-brand">{fmtInt(burnedTokens)}</span>
        </span>
      </span>
      <span className="num hidden truncate text-sm text-ink md:block">{fmtUsd(feesCollectedUsd)}</span>

      <span className="hidden min-w-0 md:block">
        <span className="num block truncate text-sm text-brand">{fmtInt(burnedTokens)}</span>
        <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-panel-2">
          <Bar frac={burnedFrac} className="bg-brand/70" />
        </span>
      </span>

      <span className="mt-3 inline-flex items-center gap-2 text-xs font-medium md:mt-0">
        {perpOpen ? (
          <>
            <LivePulse tone="brand" />
            <span className="text-brand">Perp live</span>
          </>
        ) : (
          <>
            <span aria-hidden className="size-1.5 rounded-full bg-line-2" />
            <span className="text-ink-3">Accumulating</span>
          </>
        )}
      </span>
    </Link>
  );
}

/**
 * Where the open positions point: per underlying, the notional short to the
 * left and long to the right of a centre line, so a crowded trade reads at a
 * glance.
 */
function Exposure({ positions }: { positions: OpenPosition[] }) {
  const byMarket = new Map<string, { long: number; short: number }>();
  for (const p of positions) {
    const m = byMarket.get(p.market) ?? { long: 0, short: 0 };
    m[p.side] += p.notionalUsd ?? 0;
    byMarket.set(p.market, m);
  }
  const rows = [...byMarket.entries()]
    .map(([market, v]) => ({ market, ...v }))
    .sort((a, b) => b.long + b.short - (a.long + a.short));
  const max = Math.max(1, ...rows.map((r) => Math.max(r.long, r.short)));
  const longTotal = rows.reduce((a, r) => a + r.long, 0);
  const shortTotal = rows.reduce((a, r) => a + r.short, 0);

  return (
    <section className="min-w-0 rounded-[18px] border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">Where the engines point</h2>
        <span className="text-xs text-ink-3">Open notional by asset</span>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-3">
          No position is open right now. Each engine opens once its coin has collected enough fees.
        </p>
      ) : (
        <>
          <div className="num mt-5 flex justify-between text-sm">
            <span className="text-down">Short {fmtUsd(shortTotal, 0)}</span>
            <span className="text-up">Long {fmtUsd(longTotal, 0)}</span>
          </div>
          <BarGroup className="mt-3 flex flex-col gap-2.5">
            {rows.map((r) => (
              <div key={r.market} className="grid grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)] items-center gap-2">
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {r.short > 0 && <span className="num shrink-0 text-xs text-ink-3">{fmtUsd(r.short, 0)}</span>}
                  <span className="block h-3 w-full max-w-[70%] overflow-hidden">
                    <Bar frac={r.short / max} from="right" className="bg-down/75" />
                  </span>
                </div>
                <span className="flex min-w-0 items-center justify-center gap-1.5 text-sm font-medium text-ink">
                  <AssetIcon symbol={r.market} size={16} />
                  <span className="truncate">{r.market}</span>
                </span>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="block h-3 w-full max-w-[70%] overflow-hidden">
                    <Bar frac={r.long / max} className="bg-up/75" />
                  </span>
                  {r.long > 0 && <span className="num shrink-0 text-xs text-ink-3">{fmtUsd(r.long, 0)}</span>}
                </div>
              </div>
            ))}
          </BarGroup>
        </>
      )}
    </section>
  );
}

/** Three short leaderboards from the same coins: burn, size, fees. */
function Leaders({ coins }: { coins: CoinListItem[] }) {
  const boards = [
    { title: "Most burned", pick: (c: CoinListItem) => c.burnedTokens, fmt: (v: number) => fmtInt(v), bar: "bg-brand/70" },
    { title: "Largest", pick: (c: CoinListItem) => c.marketCapUsd ?? 0, fmt: (v: number) => fmtUsd(v, 0), bar: "bg-ink/40" },
    { title: "Most fees", pick: (c: CoinListItem) => c.feesCollectedUsd, fmt: (v: number) => fmtUsd(v), bar: "bg-step-3/70" },
  ];
  return (
    <section className="min-w-0 rounded-[18px] border border-border bg-card p-5 sm:p-6">
      <h2 className="font-display text-xl font-semibold">Leaders</h2>
      <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
        {boards.map((b) => {
          const top = coins
            .map((c) => ({ c, v: b.pick(c) }))
            .filter((x) => x.v > 0)
            .sort((x, y) => y.v - x.v)
            .slice(0, 5);
          const max = top[0]?.v ?? 1;
          return (
            <div key={b.title} className="min-w-0">
              <div className="mb-2 text-xs font-medium text-ink-3">{b.title}</div>
              {top.length === 0 ? (
                <p className="text-sm text-ink-3">Nothing yet.</p>
              ) : (
                <BarGroup>
                  <ol className="flex flex-col gap-2.5">
                    {top.map(({ c, v }) => (
                      <li key={c.coin.token} className="min-w-0">
                        <Link href={`/token/${c.coin.token}`} className="group block">
                          <span className="flex items-baseline justify-between gap-2 text-sm">
                            <span className="truncate font-medium text-ink group-hover:text-brand">${c.coin.symbol}</span>
                            <span className="num shrink-0 text-ink-2">{b.fmt(v)}</span>
                          </span>
                          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-panel-2">
                            <Bar frac={v / max} className={b.bar} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ol>
                </BarGroup>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
