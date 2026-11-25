import { LIGHTER_API } from "./config";
import type { PerpPosition } from "./types";

/**
 * Letture pubbliche dall'API REST di Lighter (profilo Robinhood). Nessuna
 * firma: account e posizioni sono leggibili da chiunque conosca l'indirizzo —
 * coerente con l'etica "verify on-chain" del prodotto.
 */

async function lighterGet(
  pathname: string,
  revalidate = 5
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${LIGHTER_API}${pathname}`, { next: { revalidate } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function resolveAccountIndex(l1Address: string): Promise<number | null> {
  const j = await lighterGet(`/api/v1/accountsByL1Address?l1_address=${l1Address}`);
  if (!j || j.code !== 200) return null;
  const subs = (j.sub_accounts as { index: number }[] | undefined) ?? [];
  if (!subs.length) return null;
  return Math.min(...subs.map((s) => Number(s.index)));
}

export type TokenLogo = { logo: string; ext: string };

/**
 * Logo e ESTENSIONE di ogni token, dal tokenlist di Lighter.
 *
 * Senza questo si tira a indovinare: 39 dei 57 mercati di Robinhood Chain non
 * hanno lo svg sul CDN, quindi un fallback svg→png costa una richiesta fallita
 * (403) e un flicker per ognuno di quei simboli. Qui l'estensione e' quella
 * dichiarata dal venue, e si chiede l'immagine giusta al primo colpo.
 */
export async function allTokenLogos(): Promise<Record<string, TokenLogo>> {
  const j = await lighterGet(`/api/v1/tokenlist`, 3600);
  const tokens = (j?.tokens as Record<string, unknown>[] | undefined) ?? [];
  const out: Record<string, TokenLogo> = {};
  for (const t of tokens) {
    const symbol = String(t.symbol ?? "");
    const logo = String(t.logo ?? "").trim();
    if (!symbol || !logo) continue;
    out[symbol] = { logo, ext: String(t.logo_extension || "png") };
  }
  return out;
}

export type MarketKind = "stocks" | "crypto" | "commodities" | "preipo";

/**
 * The venue keeps the PRE_IPO tag on a name after it has listed. Anthropic has
 * traded on Nasdaq as ANT since 2026-11-19, so both its markets are stocks.
 */
const LISTED = new Set(["ANT", "ANTHROPIC"]);
/**
 * Still trading, so tokens already on it keep working, but replaced by a market
 * on the listed share: a new launch is sent there.
 */
const REPLACED: Record<string, string> = { ANTHROPIC: "ANT" };

/** the family a market is shown under, from the venue's own tags */
function kindOf(symbol: string, assetType: string, categories: string[]): MarketKind {
  if (assetType !== "RWA") return "crypto";
  if (categories.includes("COMMODITIES")) return "commodities";
  if (categories.includes("PRE_IPO") && !LISTED.has(symbol)) return "preipo";
  return "stocks";
}

export type MarketRow = {
  symbol: string;
  /** the venue's display name: "Uber Technologies, Inc." */
  name: string;
  kind: MarketKind;
  /** a new token can be pointed at it */
  launchable: boolean;
  /** where a new token goes instead, when it cannot */
  replacedBy: string | null;
  marketId: number;
  mark: number | null;
  change24h: number | null; // percento
  volume24h: number | null; // in quote (USD)
  status: string;
  /**
   * The most leverage Lighter allows on this market: 1 / min initial margin
   * fraction (basis points of 1e4). Ranges from 3x on the newest memecoins to
   * 50x on BTC, ETH, SPY and QQQ. A coin launched above it would never open its
   * position: the venue rejects the leverage update and the keeper retries
   * every tick.
   */
  maxLeverage: number | null;
  /** margin the venue closes the position at, percent of its size (1.2 on BTC, 6 on ANT) */
  maintenancePct: number | null;
};

/** tutti i mercati PERP di Lighter con mark, variazione e volume 24h */
export async function allMarkets(): Promise<MarketRow[]> {
  const [j, list] = await Promise.all([
    lighterGet(`/api/v1/orderBookDetails`),
    lighterGet(`/api/v1/tokenlist`, 3600),
  ]);
  if (!j || !Array.isArray(j.order_book_details)) return [];
  const tags = new Map(
    ((list?.tokens as Record<string, unknown>[] | undefined) ?? [])
      .filter((t) => t.market === "PERPS")
      .map((t) => [String(t.symbol), t])
  );
  // No market_id cut: ids below 255 and from 4095 up are both perps, and the type says which.
  const rows = (j.order_book_details as Record<string, unknown>[])
    .filter((o) => o.market_type === "perp" && o.status === "active")
    .map((o) => {
      const symbol = String(o.symbol);
      const tag = tags.get(symbol);
      return {
        symbol,
        name: String(tag?.name ?? symbol),
        kind: kindOf(symbol, String(tag?.asset_type ?? "CRYPTO"), (tag?.categories as string[] | undefined) ?? []),
        launchable: !(symbol in REPLACED),
        replacedBy: REPLACED[symbol] ?? null,
        marketId: Number(o.market_id),
        mark: o.mark_price != null ? Number(o.mark_price) : null,
        change24h: o.daily_price_change != null ? Number(o.daily_price_change) : null,
        volume24h: o.daily_quote_token_volume != null ? Number(o.daily_quote_token_volume) : null,
        status: String(o.status ?? ""),
        maxLeverage:
          Number(o.min_initial_margin_fraction) > 0
            ? Math.floor(10_000 / Number(o.min_initial_margin_fraction) + 1e-9)
            : null,
        maintenancePct: Number(o.maintenance_margin_fraction) > 0 ? Number(o.maintenance_margin_fraction) / 100 : null,
      };
    });
  return rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
}

/** the last 500 closes of a market, oldest first; empty when the venue does not answer or has no such size */
export async function marketCloses(symbol: string, resolution: string, size: number): Promise<{ time: number; value: number }[]> {
  if (size < 60) return []; // Lighter's smallest candle is a minute
  const id = await marketIdBySymbol(symbol);
  if (id == null) return [];
  const now = Math.ceil(Date.now() / 1000 / size) * size;
  const j = await lighterGet(
    `/api/v1/candles?market_id=${id}&resolution=${resolution}&start_timestamp=${(now - 500 * size) * 1000}&end_timestamp=${now * 1000}&count_back=500`,
    10
  );
  const rows = Array.isArray(j?.c) ? (j.c as { t: number; c: number }[]) : [];
  return rows.map((r) => ({ time: Math.floor(r.t / 1000 / size) * size, value: Number(r.c) })).filter((p) => p.value > 0);
}

export async function markPrice(marketId: number): Promise<number | null> {
  const j = await lighterGet(`/api/v1/orderBookDetails?market_id=${marketId}`);
  if (!j) return null;
  const raw = j.order_book_details;
  const ob = (Array.isArray(raw) ? raw[0] : raw) as
    | { mark_price?: unknown; index_price?: unknown; last_trade_price?: unknown }
    | undefined;
  const m = ob?.mark_price ?? ob?.index_price ?? ob?.last_trade_price;
  return m != null ? Number(m) : null;
}

export async function marketIdBySymbol(symbol: string): Promise<number | null> {
  const j = await lighterGet(`/api/v1/orderBooks`);
  if (!j || !Array.isArray(j.order_books)) return null;
  const m = (j.order_books as Record<string, unknown>[]).find((o) => o.symbol === symbol);
  return m ? Number(m.market_id) : null;
}

export async function perpPosition(
  accountIndex: number,
  marketSymbol: string
): Promise<PerpPosition | null> {
  const [accJson, marketId] = await Promise.all([
    lighterGet(`/api/v1/account?by=index&value=${accountIndex}`),
    marketIdBySymbol(marketSymbol),
  ]);
  if (!accJson || accJson.code !== 200) return null;
  const acc = (accJson.accounts as Record<string, unknown>[] | undefined)?.[0];
  if (!acc) return null;
  const positions = (acc.positions as Record<string, unknown>[] | undefined) ?? [];
  const pos = marketId != null ? positions.find((p) => Number(p.market_id) === marketId) : undefined;
  const mark = marketId != null ? await markPrice(marketId) : null;

  if (!pos) {
    return {
      accountIndex,
      marketId,
      open: false,
      collateralUsd: acc.collateral != null ? Number(acc.collateral) : null,
      positionSizeUsd: null,
      entryPrice: null,
      markPrice: mark,
      unrealizedPnlUsd: null,
      liquidationPrice: null,
      fundingPaidUsd: null,
    };
  }
  const size = Math.abs(Number(pos.position ?? 0));
  return {
    accountIndex,
    marketId,
    open: size > 0,
    collateralUsd: pos.allocated_margin != null ? Number(pos.allocated_margin) : Number(acc.collateral ?? 0),
    // il venue pubblica gia' il notional: moltiplicare size x mark reintroduce
    // uno scarto ogni volta che il mark letto non e' quello della valutazione
    positionSizeUsd:
      pos.position_value != null ? Number(pos.position_value) : mark != null ? size * mark : null,
    entryPrice: pos.avg_entry_price != null ? Number(pos.avg_entry_price) : null,
    markPrice: mark,
    unrealizedPnlUsd: pos.unrealized_pnl != null ? Number(pos.unrealized_pnl) : null,
    liquidationPrice: pos.liquidation_price != null ? Number(pos.liquidation_price) : null,
    // funding cumulativo: negativo = pagato. Non compare nel PnL non realizzato,
    // ma il collaterale l'ha gia' subito — e il keeper lo porta nel realizzato.
    fundingPaidUsd:
      pos.total_funding_paid_out != null ? Number(pos.total_funding_paid_out) : null,
  };
}
