import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";

/**
 * Token chart: a DexScreener embed of the coin's Uniswap v4 pool (the pair id is the pool id).
 *
 * DexScreener indexes Robinhood Chain under the `robinhood` slug and picks up a
 * v4 pool at its first swap, so the very pool the engine trades is there with candles,
 * volume and buy/sell counts. Better their chart than rebuilding candles from
 * Swap events: no series to maintain, no charting library in the bundle, and
 * the reader meets an interface they already know.
 *
 * `trades=0` and `info=0` switch off the sections we would be duplicating: the
 * trade list is our own live feed, the token figures are in the page header.
 *
 * Note: this is an iframe to an external host — a CSP added later needs
 * `frame-src https://dexscreener.com`.
 */

/**
 * A pool launched minutes ago is not in DexScreener's index yet, and the embed
 * would render their "pair not found" page inside ours. Ask the API first; when
 * in doubt (API down, slow network) still try the embed — better to attempt it
 * than to hide the chart of a live coin.
 */
export async function isIndexed(pool: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${pool}`, {
      next: { revalidate: 300 },
    });
    if (!r.ok) return true;
    const j = (await r.json()) as { pairs?: unknown[] | null };
    return !!j.pairs?.length;
  } catch {
    return true;
  }
}

export const dexPage = (pool: string) => `https://dexscreener.com/robinhood/${pool}`;
export const dexEmbed = (pool: string) =>
  `${dexPage(pool)}?embed=1&loadChartSettings=0&theme=light&chartTheme=light` +
  `&info=0&trades=0&tabs=0&chartLeftToolbar=0&chartDefaultOnMobile=1&interval=15`;

export default async function Chart({ pool, symbol }: { pool: string; symbol: string }) {
  const page = dexPage(pool);
  const indexed = await isIndexed(pool);
  const src = dexEmbed(pool);

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <PanelTitle>${symbol} · token chart</PanelTitle>
        <a
          href={page}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-ink-3 transition-colors hover:text-brand"
        >
          DexScreener ↗
        </a>
      </PanelHeader>
      <div className="relative h-[380px] bg-panel-2 sm:h-[520px]">
        {indexed ? (
          <iframe
            src={src}
            title={`${symbol} price chart on DexScreener`}
            className="absolute inset-0 h-full w-full border-0"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-md font-semibold text-ink">Chart coming shortly</span>
            <span className="max-w-[380px] text-sm leading-relaxed text-ink-3">
              DexScreener picks up the pool shortly after its first swap.
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}
