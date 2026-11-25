import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { loadFlywheel, type Buyback } from "@/lib/flywheel";
import { explorerTx } from "@/lib/clientConfig";
import { FLYWHEEL } from "@/lib/doppler";
import { fmtInt, fmtUsd } from "@/lib/format";
import type { CoinListItem } from "@/lib/types";
import { Container } from "@/components/ui/container";
import { AnimatedNumber, Reveal, RevealBlock, RevealItem } from "@/components/motion";
import AutoRefresh from "@/components/AutoRefresh";
import { Guilloche } from "@/components/brand/Guilloche";
import { CoinAvatar } from "@/components/brand/CoinAvatar";
import { BurningNote } from "@/components/burn/BurningNote";
import NextBuyback from "@/components/burn/NextBuyback";
import RevenueSplit from "@/components/burn/RevenueSplit";
import { Bar, BarGroup } from "@/components/stats/Bars";

export const metadata = {
  title: "Buyback & burn",
  description: `${FLYWHEEL.buybackPct}% of what the protocol earns buys $MULTIPLY and burns it, every ${FLYWHEEL.everyMin} minutes.`,
};
export const dynamic = "force-dynamic";

/**
 * The platform's buyback & burn: the note that gets smaller, where the money comes from, the next
 * buy, every buy so far, and the tokens that burn themselves with their own engines.
 */
export default async function BurnPage() {
  const { flywheel: fw, coins } = await loadFlywheel();
  const live = fw.token != null;
  const supply = fw.token?.coin.initialSupply ?? 1e9;
  const totals = [
    { k: "Earned by the protocol", v: <AnimatedNumber value={fw.revenueUsd} format="usd" countOnMount /> },
    { k: "Spent on buybacks", v: <AnimatedNumber value={fw.spentUsd} format="usd" countOnMount /> },
    { k: "Buybacks", v: <AnimatedNumber value={fw.buybacks.length} format="plain" countOnMount /> },
  ];
  const burners = coins.filter((c) => c.burnedTokens > 0).sort((a, b) => b.burnedTokens - a.burnedTokens);

  return (
    <>
      <section className="intro-night behind-nav relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]">
        <div aria-hidden className="pointer-events-none absolute top-[48%] left-[70%] -z-10 text-mint/[0.09]">
          <Guilloche teeth={37} reach={0.84} rings={4} size={900} spin={190} className="w-[120vw] max-w-[900px]" />
        </div>
        <div className="mx-auto grid w-full max-w-[1320px] grid-cols-1 gap-12 px-4 pt-10 pb-12 sm:px-5 sm:pt-14 sm:pb-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center">
          <div className="min-w-0">
            <h1 className="font-display text-[clamp(44px,6vw,84px)] leading-[0.95] font-bold tracking-[-0.04em] text-night-ink">
              Buyback <span className="type-engraved [--ink-c:var(--color-mint)]">&amp; burn</span>
            </h1>
            <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-night-ink-2">
              {FLYWHEEL.buybackPct}% of what the protocol earns buys $MULTIPLY on its own pool and burns it, every{" "}
              {FLYWHEEL.everyMin} minutes.
            </p>
            {live ? (
              <>
                <div className="mt-9 text-xs tracking-wide text-night-ink-2">$MULTIPLY burned</div>
                <div className="num mt-2 truncate text-[clamp(44px,6.4vw,84px)] leading-none font-semibold tracking-[-0.03em] text-mint">
                  <AnimatedNumber value={fw.burned} format="int" countOnMount />
                </div>
                <div className="num mt-2 text-sm text-night-ink-2">{((fw.burned / supply) * 100).toFixed(4)}% of the supply</div>
                <dl className="mt-8 grid max-w-[560px] grid-cols-2 gap-x-8 gap-y-5 border-t border-night-line pt-6 sm:grid-cols-3">
                  {totals.map((s) => (
                    <div key={s.k} className="min-w-0">
                      <dt className="text-xs text-night-ink-2">{s.k}</dt>
                      <dd className="num mt-1 truncate text-2xl font-semibold">{s.v}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="mt-8 max-w-[46ch] rounded-[14px] border border-night-line px-5 py-4 text-base leading-relaxed text-night-ink">
                It starts when $MULTIPLY launches. Until then the note is whole.
              </p>
            )}
          </div>
          <div className="min-w-0 text-mint">
            <BurningNote symbol={fw.token?.coin.symbol ?? "MULTIPLY"} burned={fw.burned} supply={supply} className="lg:-rotate-2" />
          </div>
        </div>
      </section>

      <Container width="landing" className="pb-10">
        <section className="mt-16 sm:mt-20">
          <RevealBlock className="max-w-[640px]">
            <h2 className="text-3xl leading-[1.1] font-bold tracking-[-0.03em] sm:text-4xl">Where the money comes from.</h2>
            <p className="mt-3 max-w-[54ch] text-lg leading-relaxed text-ink-2">
              The protocol earns twice: a share of every trading fee, and a share of the gain when a token&apos;s position takes profit. Both
              are cut the same way.
            </p>
          </RevealBlock>
          <div className="mt-9">
            <RevenueSplit />
          </div>
        </section>

        <section className="mt-16 grid grid-cols-1 gap-6 sm:mt-20 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
          <div className="min-w-0 space-y-6">
            {live && <NextBuyback waitingUsd={fw.waitingUsd} lastRunAt={fw.lastRunAt} />}
            <section className="rounded-[18px] border border-line bg-panel p-5 sm:p-6">
              <h2 className="font-display text-xl font-semibold">How a buyback goes out</h2>
              <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-2">
                {[
                  `Every ${FLYWHEEL.everyMin} minutes the keeper counts what has been earned since the last time.`,
                  `It buys from ${fmtUsd(FLYWHEEL.minUsd, 0)} up, in a size that moves the price by ${FLYWHEEL.impactPct}% at most. The rest waits for the next one.`,
                  "What it bought is burned right after, and nothing else: supply only goes down.",
                  "It never buys while a launch protection is still high.",
                ].map((t) => (
                  <li key={t} className="flex gap-3">
                    <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <Buybacks rows={fw.buybacks} symbol={fw.token?.coin.symbol ?? "MULTIPLY"} />
        </section>

        <section className="mt-16 sm:mt-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <RevealBlock className="max-w-[640px]">
              <h2 className="text-3xl leading-[1.1] font-bold tracking-[-0.03em] sm:text-4xl">Every token burns itself, too.</h2>
              <p className="mt-3 max-w-[54ch] text-lg leading-relaxed text-ink-2">
                When a token&apos;s own position takes profit, its capital and most of the gain buy that token and burn it.
              </p>
            </RevealBlock>
            <AutoRefresh everyMs={30_000} />
          </div>
          <Burners rows={burners} />
        </section>
      </Container>
    </>
  );
}

function Buybacks({ rows, symbol }: { rows: Buyback[]; symbol: string }) {
  return (
    <section className="min-w-0 rounded-[18px] border border-line bg-panel p-5 sm:p-6">
      <h2 className="font-display text-xl font-semibold">Buybacks so far</h2>
      {rows.length === 0 ? (
        <p className="mt-4 rounded-[14px] border border-dashed border-line-2 px-5 py-10 text-center text-sm text-ink-3">
          The first one will be listed here, with its transactions.
        </p>
      ) : (
        <Reveal as="ul" className="mt-3 divide-y divide-line">
          {rows.map((r) => (
            <RevealItem as="li" key={r.buyTx} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="num truncate text-base font-semibold text-ink">
                  {fmtInt(r.tokens)} <span className="font-normal text-ink-3">${symbol}</span>
                </div>
                <div className="num truncate text-xs text-ink-3">
                  {fmtUsd(r.usd)} · {new Date(r.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}
                  <span className="hidden sm:inline"> UTC</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-3 text-sm">
                <TxLink tx={r.buyTx} label="Buy" />
                {r.burnTx ? <TxLink tx={r.burnTx} label="Burn" /> : <span className="text-ink-3">Burning</span>}
              </div>
            </RevealItem>
          ))}
        </Reveal>
      )}
    </section>
  );
}

function TxLink({ tx, label }: { tx: string; label: string }) {
  return (
    <a href={explorerTx(tx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand underline-offset-4 hover:underline">
      {label}
      <ArrowUpRight size={14} aria-hidden />
    </a>
  );
}

function Burners({ rows }: { rows: CoinListItem[] }) {
  if (rows.length === 0)
    return (
      <p className="mt-6 rounded-[18px] border border-dashed border-line-2 px-6 py-10 text-center text-ink-3">
        No token has burned yet. The first take-profit will.
      </p>
    );
  const max = rows[0].burnedTokens;
  return (
    <BarGroup className="mt-6">
      <ol className="divide-y divide-line border-y border-line">
        {rows.slice(0, 12).map((c) => (
          <li key={c.coin.token}>
            <Link href={`/token/${c.coin.token}`} className="group flex items-center gap-4 px-1 py-3 transition-colors hover:bg-panel sm:px-3">
              <CoinAvatar image={c.coin.image} symbol={c.coin.symbol} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-ink group-hover:text-brand">${c.coin.symbol}</span>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-panel-2">
                  <Bar frac={c.burnedTokens / max} className="bg-brand/70" />
                </span>
              </span>
              <span className="num shrink-0 text-right text-sm text-brand">{fmtInt(c.burnedTokens)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </BarGroup>
  );
}
