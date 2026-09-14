"use client";

import type { CoinDetail } from "@/lib/types";
import { fmtUsd, fmtSignedUsd, fmtMark } from "@/lib/format";
import { OPEN_GATE_USD, fmtThreshold } from "@/lib/thresholds";
import { useLiveMark, useLivePositions } from "@/hooks/use-lighter-live";
import AssetIcon from "./AssetIcon";
import { Activity } from "@/components/animate-ui/icons/activity";
import { LivePulse } from "@/components/motion";

/**
 * La gamba perp su Lighter: la card e' l'unico elemento con bordo accent pieno —
 * e' il motore che distingue il prodotto da un normale meme-launchpad.
 *
 * I numeri arrivano dal server al primo render e poi da due canali dello stream
 * di Lighter, nessuno dei quali chiede autenticazione: quello del CONTO dice
 * cos'e' la posizione (size, entry, margine, liquidazione, funding) e parla solo
 * quando cambia davvero; quello del MERCATO dice quanto vale adesso. PnL e
 * notional si ricalcolano dal mark invece di aspettare che il venue li rimandi,
 * altrimenti resterebbero fermi per ore su una posizione che nessuno tocca.
 */
export default function HedgeCard({ detail }: { detail: CoinDetail }) {
  const { coin, perp, stats } = detail;
  const all = useLivePositions(perp?.accountIndex);
  const live = perp?.marketId != null ? (all?.[perp.marketId] ?? null) : null;

  // `all === null` = lo stream non ha ancora parlato: si resta sul dato del
  // server. Se ha parlato, l'assenza della posizione significa chiusa davvero.
  const open = all != null ? !!live : !!perp?.open;

  const size = live?.size ?? null;
  const entryPrice = live?.entryPrice ?? perp?.entryPrice ?? null;
  const markPrice = useLiveMark(perp?.marketId) ?? perp?.markPrice ?? null;
  const sign = live?.sign ?? (coin.side === "short" ? -1 : 1);

  // col mark fresco il PnL si ricalcola invece di ereditare quello vecchio: e'
  // la stessa formula del venue (sign x (mark - entry) x size), verificata sul
  // conto di una coin viva contro il suo `unrealized_pnl`
  const pnl =
    markPrice != null && size && entryPrice != null
      ? sign * (markPrice - entryPrice) * size
      : (live?.unrealizedPnlUsd ?? perp?.unrealizedPnlUsd ?? null);
  const collateralUsd = live?.allocatedMarginUsd ?? perp?.collateralUsd ?? null;
  const positionSizeUsd =
    markPrice != null && size
      ? markPrice * size
      : (live?.positionValueUsd ?? perp?.positionSizeUsd ?? null);
  const liquidationPrice = live?.liquidationPrice ?? perp?.liquidationPrice ?? null;
  const fundingUsd = live?.fundingPaidUsd ?? perp?.fundingPaidUsd ?? null;

  const pnlTone = pnl == null ? "text-ink" : pnl >= 0 ? "text-up" : "text-down";

  const cells: { label: string; value: string; tone?: string }[] = open
    ? [
        { label: "collateral", value: fmtUsd(collateralUsd) },
        { label: "position size", value: fmtUsd(positionSizeUsd) },
        { label: "leverage", value: `${coin.leverage}×` },
        { label: "entry price", value: fmtMark(entryPrice) },
        { label: "mark price", value: fmtMark(markPrice) },
        { label: "liquidation", value: fmtMark(liquidationPrice) },
        { label: "unrealized pnl", value: fmtSignedUsd(pnl), tone: pnlTone },
        // il funding non compare nel pnl non realizzato ma il collaterale l'ha
        // gia' subito: tenerlo fuori dalla card lo renderebbe invisibile finche'
        // non manca all'appello in un prelievo
        {
          label: "funding paid",
          value: fmtSignedUsd(fundingUsd),
          tone: fundingUsd == null ? "text-ink" : fundingUsd >= 0 ? "text-up" : "text-down",
        },
      ]
    : [
        { label: "perp reserve", value: fmtUsd(stats.perpReserveUsd) },
        { label: "open gate", value: fmtThreshold(OPEN_GATE_USD) },
        { label: "leverage", value: `${coin.leverage}×` },
        { label: "market", value: coin.market },
      ];

  return (
    <div className="overflow-hidden rounded-[14px] border border-brand/35 bg-panel shadow-[0_1px_2px_rgba(12,52,32,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-brand-soft px-5 py-3">
        <span className="flex items-center gap-2 text-md font-semibold text-brand">
          <AssetIcon symbol={coin.market} size={18} />
          <Activity aria-hidden size={16} animation="default-loop" loop={open} className="text-brand" />
          Perp hedge · {coin.leverage}× {coin.side} {coin.market}
        </span>
        <span className="flex items-center gap-2 text-xs text-brand">
          {coin.riskProfile && (
            <span className="rounded-full bg-panel px-2 py-0.5 text-xs font-medium capitalize">
              {coin.riskProfile}
            </span>
          )}
          {open ? (
            <span className="flex items-center gap-1.5">
              <LivePulse tone="brand" />
              Live on Lighter
            </span>
          ) : (
            `Opens when reserve ≥ ${fmtThreshold(OPEN_GATE_USD)} (now ${fmtUsd(stats.perpReserveUsd)})`
          )}
        </span>
      </div>
      {/* due colonne sul telefono, quattro da md: 4 e 8 celle riempiono entrambe
          le griglie senza lasciare buchi, aperta o chiusa che sia la posizione */}
      <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="bg-panel px-4 py-3.5">
            <div className="mb-1 text-xs text-ink-3 first-letter:uppercase">{c.label}</div>
            <div className={`num text-lg font-semibold max-[359px]:text-base ${c.tone ?? "text-ink"}`}>
              {c.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
