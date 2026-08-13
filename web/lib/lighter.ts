import { LIGHTER_API } from "./config";
import type { PerpPosition } from "./types";

/**
 * Letture pubbliche dall'API REST di Lighter (profilo Robinhood). Nessuna
 * firma: account e posizioni sono leggibili da chiunque conosca l'indirizzo —
 * coerente con l'etica "verify on-chain" del prodotto.
 */

async function lighterGet(pathname: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${LIGHTER_API}${pathname}`, { next: { revalidate: 5 } });
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

export type MarketRow = {
  symbol: string;
  marketId: number;
  mark: number | null;
  change24h: number | null; // percento
  volume24h: number | null; // in quote (USD)
  status: string;
};

/** tutti i mercati PERP di Lighter con mark, variazione e volume 24h */
export async function allMarkets(): Promise<MarketRow[]> {
  const j = await lighterGet(`/api/v1/orderBookDetails`);
  if (!j || !Array.isArray(j.order_book_details)) return [];
  const rows = (j.order_book_details as Record<string, unknown>[])
    .filter((o) => o.market_type === "perp" && Number(o.market_id) < 2048)
    .map((o) => ({
      symbol: String(o.symbol),
      marketId: Number(o.market_id),
      mark: o.mark_price != null ? Number(o.mark_price) : null,
      change24h: o.daily_price_change != null ? Number(o.daily_price_change) : null,
      volume24h: o.daily_quote_token_volume != null ? Number(o.daily_quote_token_volume) : null,
      status: String(o.status ?? ""),
    }));
  return rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
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
      open: false,
      collateralUsd: acc.collateral != null ? Number(acc.collateral) : null,
      positionSizeUsd: null,
      entryPrice: null,
      markPrice: mark,
      unrealizedPnlUsd: null,
      liquidationPrice: null,
    };
  }
  const size = Math.abs(Number(pos.position ?? pos.size ?? 0));
  return {
    open: size > 0,
    collateralUsd: pos.allocated_margin != null ? Number(pos.allocated_margin) : Number(acc.collateral ?? 0),
    positionSizeUsd: mark != null ? size * mark : null,
    entryPrice: pos.avg_entry_price != null ? Number(pos.avg_entry_price) : null,
    markPrice: mark,
    unrealizedPnlUsd: pos.unrealized_pnl != null ? Number(pos.unrealized_pnl) : null,
    liquidationPrice: pos.liquidation_price != null ? Number(pos.liquidation_price) : null,
  };
}
