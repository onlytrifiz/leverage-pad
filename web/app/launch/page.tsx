import LaunchForm from "@/components/LaunchForm";
import { MarketsProvider } from "@/components/markets-provider";

export const metadata = { title: "Launch" };

/**
 * `?market=TSLA&side=short` presets the form (the market page's movers link
 * here). Both are checked: a symbol is letters and digits only, the side one of
 * two words; anything else falls back to the defaults.
 */
export default async function LaunchPage({
  searchParams,
}: {
  searchParams: Promise<{ market?: string; side?: string }>;
}) {
  const sp = await searchParams;
  const market = sp.market && /^[A-Z0-9]{1,16}$/i.test(sp.market) ? sp.market.toUpperCase() : undefined;
  const side = sp.side === "short" || sp.side === "long" ? sp.side : undefined;
  return (
    <MarketsProvider>
      <LaunchForm initialMarket={market} initialSide={side} />
    </MarketsProvider>
  );
}
