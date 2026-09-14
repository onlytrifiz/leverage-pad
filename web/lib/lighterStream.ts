"use client";

import { LIGHTER_WS } from "./clientConfig";

/**
 * Una sola connessione allo stream di Lighter per scheda del browser.
 *
 * Il sito leggeva tutto in polling: il ticker e il rail dei mercati ogni 20s,
 * le posizioni ogni 20s, la pagina di una coin con un `router.refresh()`. Sono
 * numeri che si muovono a ogni blocco, mostrati con un ritardo che non serve a
 * nessuno. I canali di sola lettura di Lighter li mandano in push, e quelli di
 * un conto non chiedono autenticazione: `account_all_positions_fe/<idx>` si
 * apre con l'indice e basta — verificato sul conto di una coin viva.
 *
 * Sta in un modulo, non in un context, perche' le stesse letture servono a
 * pagine che non montano lo stesso provider. Il socket si apre al primo
 * iscritto e si chiude quando l'ultimo se ne va.
 *
 * LA REGOLA DEL PROTOCOLLO, che e' facile sbagliare: `subscribed/x` e' lo
 * snapshot e SOSTITUISCE, `update/x` e' il delta e si FONDE. Invertirle da'
 * uno stato che sembra giusto e poi deriva — un `update` con `positions: {}`
 * significa "niente di nuovo", non "posizione chiusa".
 */

export type MarketStat = {
  marketId: number;
  symbol: string;
  mark: number | null;
  indexPrice: number | null;
  change24h: number | null;
  volume24h: number | null;
  fundingRate: number | null;
};

export type LivePosition = {
  marketId: number;
  symbol: string;
  /** 1 long, -1 short (il venue manda 1/0) */
  sign: number;
  size: number;
  entryPrice: number | null;
  positionValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  liquidationPrice: number | null;
  allocatedMarginUsd: number | null;
  fundingPaidUsd: number | null;
};

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── stato condiviso ──────────────────────────────────────────────────────────

let socket: WebSocket | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let retry = 0;
/** backoff dello stesso SDK di Lighter: 3s → 6s → 10s → 15s, poi fisso */
const BACKOFF = [3000, 6000, 10000, 15000];

/** canale → numero di iscritti; il socket rimanda le subscribe a ogni riconnessione */
const channels = new Map<string, number>();

let stats: Record<number, MarketStat> = {};
const positions = new Map<number, Record<number, LivePosition>>();

const statsListeners = new Set<(s: Record<number, MarketStat>) => void>();
const posListeners = new Map<number, Set<(p: Record<number, LivePosition>) => void>>();

const emitStats = () => {
  for (const fn of statsListeners) fn(stats);
};
const emitPositions = (accountIndex: number) => {
  const snap = positions.get(accountIndex) ?? {};
  for (const fn of posListeners.get(accountIndex) ?? []) fn(snap);
};

// ── parsing ──────────────────────────────────────────────────────────────────

function toStat(raw: Json): MarketStat {
  return {
    marketId: Number(raw.market_id),
    symbol: String(raw.symbol ?? ""),
    mark: num(raw.mark_price),
    indexPrice: num(raw.index_price),
    change24h: num(raw.daily_price_change),
    volume24h: num(raw.daily_quote_token_volume),
    fundingRate: num(raw.current_funding_rate ?? raw.funding_rate),
  };
}

function toPosition(raw: Json, prev?: LivePosition): LivePosition {
  return {
    marketId: Number(raw.market_id),
    symbol: String(raw.symbol ?? prev?.symbol ?? ""),
    sign: Number(raw.sign) === 0 ? -1 : 1,
    size: Math.abs(Number(raw.position ?? 0)),
    entryPrice: num(raw.avg_entry_price),
    positionValueUsd: num(raw.position_value),
    unrealizedPnlUsd: num(raw.unrealized_pnl),
    liquidationPrice: num(raw.liquidation_price),
    allocatedMarginUsd: num(raw.allocated_margin),
    // il funding arriva per conto proprio (last_funding_round), non dentro la
    // posizione: se non c'e' in questo messaggio si tiene quello gia' noto
    fundingPaidUsd: num(raw.total_funding_paid_out) ?? prev?.fundingPaidUsd ?? null,
  };
}

function accountIndexOf(channel: string): number | null {
  // "account_all_positions_fe:1311" — il venue risponde con ':' dove la
  // subscribe usa '/', quindi si accettano entrambi
  const idx = Number(channel.split(/[/:]/)[1]);
  return Number.isFinite(idx) ? idx : null;
}

function handle(msg: Json) {
  const type = String(msg.type ?? "");

  if (type === "subscribed/market_stats" || type === "update/market_stats") {
    const channel = String(msg.channel ?? "");
    const raw = (msg.market_stats ?? {}) as Json;
    // `market_stats/all` manda una mappa per market_id, `market_stats/<id>` manda
    // il singolo mercato nudo. E solo lo snapshot del canale "all" puo' azzerare
    // la mappa: quello di un mercato solo cancellerebbe tutti gli altri.
    const rows = channel.endsWith("all") ? Object.values(raw as Record<string, Json>) : [raw];
    const next =
      type === "subscribed/market_stats" && channel.endsWith("all") ? {} : { ...stats };
    for (const row of rows) {
      const stat = toStat(row);
      if (Number.isFinite(stat.marketId)) next[stat.marketId] = stat;
    }
    stats = next;
    emitStats();
    return;
  }

  if (
    type === "subscribed/account_all_positions_fe" ||
    type === "update/account_all_positions_fe"
  ) {
    const account = accountIndexOf(String(msg.channel ?? ""));
    if (account == null) return;
    const snapshot = type.startsWith("subscribed");
    const next: Record<number, LivePosition> = snapshot
      ? {}
      : { ...(positions.get(account) ?? {}) };

    const raw = (msg.positions ?? {}) as Record<string, Json>;
    for (const [key, row] of Object.entries(raw)) {
      const pos = toPosition(row, next[Number(key)]);
      // size a zero = posizione chiusa: sparisce invece di restare a zero
      if (pos.size > 0) next[pos.marketId] = pos;
      else delete next[pos.marketId];
    }

    // funding cumulativo, mandato a parte a ogni round
    const funding = (msg.last_funding_round ?? {}) as Record<string, unknown>;
    for (const [mid, value] of Object.entries(funding)) {
      const existing = next[Number(mid)];
      if (existing) next[Number(mid)] = { ...existing, fundingPaidUsd: num(value) };
    }

    positions.set(account, next);
    emitPositions(account);
  }
}

// ── connessione ──────────────────────────────────────────────────────────────

function send(ws: WebSocket, type: "subscribe" | "unsubscribe", channel: string) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, channel }));
}

function connect() {
  if (socket || typeof window === "undefined" || !channels.size) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${LIGHTER_WS}?encoding=json&readonly=true`);
  } catch {
    return; // niente WebSocket qui: i componenti restano sui dati del server
  }
  socket = ws;

  ws.onopen = () => {
    retry = 0;
    for (const channel of channels.keys()) send(ws, "subscribe", channel);
  };

  ws.onmessage = (e) => {
    try {
      handle(JSON.parse(String(e.data)) as Json);
    } catch {
      /* un messaggio malformato non deve buttare giu' il socket */
    }
  };

  const reopen = () => {
    if (socket !== ws) return;
    socket = null;
    if (!channels.size) return;
    const wait = BACKOFF[Math.min(retry, BACKOFF.length - 1)];
    retry += 1;
    setTimeout(connect, wait);
  };
  ws.onclose = reopen;
  ws.onerror = () => ws.close();
}

function acquire(channel: string) {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  const n = (channels.get(channel) ?? 0) + 1;
  channels.set(channel, n);
  if (!socket) connect();
  else if (n === 1) send(socket, "subscribe", channel);
}

function release(channel: string) {
  const n = (channels.get(channel) ?? 1) - 1;
  if (n > 0) {
    channels.set(channel, n);
    return;
  }
  channels.delete(channel);
  if (socket) send(socket, "unsubscribe", channel);
  if (!channels.size && socket) {
    // un attimo di grazia: in React 18+ un effetto viene smontato e rimontato
    // subito in dev, e chiudere di scatto significa riaprire un socket ogni volta
    closeTimer = setTimeout(() => {
      if (!channels.size && socket) {
        const ws = socket;
        socket = null;
        ws.onclose = null;
        ws.close();
      }
      closeTimer = null;
    }, 5000);
  }
}

// ── API pubblica ─────────────────────────────────────────────────────────────

/** snapshot corrente: il riferimento cambia solo quando cambiano i dati */
export const getMarketStats = () => stats;
export const getAccountPositions = (accountIndex: number) =>
  positions.get(accountIndex) ?? null;

/**
 * Tutti i mercati in push.
 *
 * COSTA: misurato sul canale vero, 508KB in 20 secondi — 1.5MB al minuto, venti
 * volte il polling REST che mostra la stessa lista ogni 20s. Per un ticker di 57
 * righe lo streaming e' la scelta sbagliata, e questa funzione resta qui solo
 * per chi avesse davvero bisogno di ogni mercato in tempo reale. Per seguire UN
 * mercato c'e' `subscribeMarketStat`, che costa 0.3KB/s.
 */
export function subscribeMarketStats(fn: (s: Record<number, MarketStat>) => void) {
  statsListeners.add(fn);
  acquire("market_stats/all");
  if (Object.keys(stats).length) fn(stats);
  return () => {
    statsListeners.delete(fn);
    release("market_stats/all");
  };
}

/** un mercato solo: e' la forma che conviene a una pagina che ne mostra uno */
export function subscribeMarketStat(marketId: number, fn: () => void) {
  statsListeners.add(fn);
  const channel = `market_stats/${marketId}`;
  acquire(channel);
  if (stats[marketId]) fn();
  return () => {
    statsListeners.delete(fn);
    release(channel);
  };
}

export function subscribeAccountPositions(
  accountIndex: number,
  fn: (p: Record<number, LivePosition>) => void
) {
  const channel = `account_all_positions_fe/${accountIndex}`;
  let set = posListeners.get(accountIndex);
  if (!set) {
    set = new Set();
    posListeners.set(accountIndex, set);
  }
  set.add(fn);
  acquire(channel);
  const known = positions.get(accountIndex);
  if (known) fn(known);
  return () => {
    set.delete(fn);
    if (!set.size) posListeners.delete(accountIndex);
    release(channel);
  };
}
