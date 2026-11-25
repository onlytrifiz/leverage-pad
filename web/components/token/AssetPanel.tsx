"use client";

import { useEffect, useRef, useState } from "react";
import { ColorType, CrosshairMode, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { cn } from "cn";
import type { CoinDetail } from "@/lib/types";
import { fmtChange, fmtMark } from "@/lib/format";
import { useMarketStat } from "@/hooks/use-lighter-live";
import { useMarkets } from "@/components/markets-provider";
import AssetIcon from "@/components/AssetIcon";

/**
 * The market the engine trades, beside the token's chart and as tall as what is left there: its
 * price, and where the open position entered and would be liquidated.
 */

const ASSET = "#3b6fb5";
const INK = "#0c3420";
const DOWN = "#b3261e";
const AXIS = "#566c5e";

const RANGES = ["1d", "1w", "1m"] as const;
type Range = (typeof RANGES)[number];

export default function AssetPanel({ detail }: { detail: CoinDetail }) {
  const { coin, perp } = detail;
  // during a switch the open position is still the previous engine's
  const { market, side } = detail.engineSwitch?.from ?? coin;
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const line = useRef<ISeriesApi<"Line"> | null>(null);
  const bounds = useRef<number[]>([]);
  const [range, setRange] = useState<Range>("1d");
  const [points, setPoints] = useState<{ key: string; rows: { time: number; value: number }[] } | null>(null);
  const stat = useMarketStat(perp?.marketId);
  const { markets } = useMarkets();
  const row = markets.find((m) => m.symbol === market);
  const key = `${market}:${range}`;

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      fetch(`/api/markets/closes?symbol=${encodeURIComponent(market)}&range=${range}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => alive && setPoints({ key, rows: j.points }))
        .catch(() => {}); // the last good line stays
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [market, range, key]);

  useEffect(() => {
    const mono = getComputedStyle(document.body).getPropertyValue("--font-plex-mono").trim() || "monospace";
    const c = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: AXIS, fontFamily: mono, fontSize: 10, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { visible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(12,52,32,0.3)", width: 1, style: LineStyle.Dotted, labelVisible: false },
        horzLine: { color: "rgba(12,52,32,0.3)", width: 1, style: LineStyle.Dotted, labelBackgroundColor: INK },
      },
      localization: { priceFormatter: (n: number) => fmtMark(n) },
      // a glance, not a tool: the page scrolls through it
      handleScroll: false,
      handleScale: false,
    });
    line.current = c.addSeries(LineSeries, {
      color: ASSET,
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: { type: "custom", formatter: (n: number) => fmtMark(n), minMove: 1e-9 },
      // the entry and the liquidation stay in sight when they are near enough to matter
      autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const b = base();
        if (!b?.priceRange) return b;
        const { minValue, maxValue } = b.priceRange;
        const room = Math.max(maxValue - minValue, maxValue * 0.005) * 1.5;
        const near = bounds.current.filter((v) => v > minValue - room && v < maxValue + room);
        return { ...b, priceRange: { minValue: Math.min(minValue, ...near), maxValue: Math.max(maxValue, ...near) } };
      },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      line.current = null;
    };
  }, []);

  const rows = points?.rows ?? null;
  useEffect(() => {
    if (!rows || !line.current) return;
    line.current.setData(rows.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    chart.current?.timeScale().fitContent();
  }, [rows]);

  const entry = perp?.open ? perp.entryPrice : null;
  const liq = perp?.open ? perp.liquidationPrice : null;
  useEffect(() => {
    const s = line.current;
    if (!s) return;
    bounds.current = [entry, liq].filter((v): v is number => v != null && v > 0);
    const drawn = [
      entry ? s.createPriceLine({ price: entry, color: INK, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "entry" }) : null,
      liq ? s.createPriceLine({ price: liq, color: DOWN, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "liquidation" }) : null,
    ];
    return () => {
      if (!chart.current) return;
      for (const d of drawn) if (d) s.removePriceLine(d);
    };
  }, [entry, liq]);

  const mark = stat?.mark ?? row?.mark ?? perp?.markPrice ?? rows?.[rows.length - 1]?.value ?? null;
  const change = stat?.change24h ?? row?.change24h ?? null;

  return (
    <section aria-label={`${market}, what the fees trade`} className="flex h-[200px] min-h-0 flex-col lg:h-auto lg:min-h-[96px] lg:flex-1 overflow-hidden rounded-[18px] border border-line bg-panel">
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <AssetIcon symbol={market} size={26} />
          <div className="min-w-0">
            <div className="truncate text-sm leading-tight font-semibold text-ink">
              {market} <span className={cn("font-medium", side === "long" ? "text-up" : "text-down")}>{coin.leverage}x {side}</span>
            </div>
            <div className="num text-xs text-ink-3">
              <span className="text-ink">{mark == null ? "—" : fmtMark(mark)}</span>{" "}
              {change != null && <span className={change >= 0 ? "text-up" : "text-down"}>{fmtChange(change)}</span>}
            </div>
          </div>
        </div>
        <div role="radiogroup" aria-label="Range" className="flex shrink-0">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              onClick={() => setRange(r)}
              className={cn("num rounded-md px-2 py-1 text-xs uppercase transition-colors", range === r ? "bg-brand-soft font-semibold text-brand" : "text-ink-3 hover:text-ink")}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className={cn("relative mt-1 min-h-0 flex-1 transition-opacity", points != null && points.key !== key && "opacity-45")}>
      <div
        ref={box}
        role="img"
        aria-label={`${market} over ${range}${mark == null ? "" : `, now ${fmtMark(mark)}`}`}
        // out of the flow: a canvas in it would hold the panel at the height it was first drawn
        className="absolute inset-0"
      />
      </div>
    </section>
  );
}
