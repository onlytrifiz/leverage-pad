"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { cn } from "cn";
import type { Candle, FeedItem } from "@/lib/types";
import { fmtPrice } from "@/lib/format";

/**
 * The coin's own chart, drawn from its pool's swaps, with the engine on it.
 *
 * DexScreener draws the price; only this chart can draw *why* it moved: every
 * buyback and burn the engine made is a marker on the bar it landed in, and a
 * dashed line holds the launch price. Those markers are the product, visible.
 * DexScreener stays one tab away for anyone who wants its tools.
 *
 * Line by default while a coin has few bars (a handful of candles reads as
 * noise), candles once there is a real series. Colours and type come from the
 * site's tokens so it reads as part of the page, not a widget pasted in.
 */

type Mode = "line" | "candles" | "dex";

const INK_3 = "#566c5e";
const UP = "#0f7a43";
const DOWN = "#b3261e";
const BRAND = "#0f6b3f";

export default function CoinChart({
  address,
  symbol,
  launchPrice,
  launchedAt,
  dexSrc,
  dexPage,
}: {
  address: string;
  symbol: string;
  launchPrice: number | null;
  /** unix seconds: the line starts at the launch price, at the launch */
  launchedAt: number | null;
  /** null when DexScreener has not indexed the pool yet */
  dexSrc: string | null;
  dexPage: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [mode, setMode] = useState<Mode | null>(null);

  /*
   * Candles and engine events load independently: the line draws as soon as
   * its bars arrive, the markers join when the feed does. Waiting for both
   * held the whole chart hostage to the slower scan.
   */
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`/api/coin/${address}/candles`)
        .then((r) => r.json())
        .then((c) => alive && setCandles(c.candles ?? []))
        .catch(() => alive && setCandles((prev) => prev ?? []));
      fetch(`/api/coin/${address}/feed`)
        .then((r) => r.json())
        .then((f) => alive && setEvents((f.items ?? []).filter((e: FeedItem) => e.kind === "buyback" || e.kind === "burn")))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [address]);

  const effective: Mode = mode ?? (candles && candles.length >= 24 ? "candles" : "line");

  useEffect(() => {
    const el = box.current;
    if (!el || !candles?.length || effective === "dex") return;
    const mono = getComputedStyle(document.body).getPropertyValue("--font-plex-mono") || "monospace";

    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: INK_3,
        fontFamily: mono,
        fontSize: 11,
        // the library's licence asks for TradingView's attribution; its own logo is the intended way
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "rgba(12,52,32,0.045)" },
        horzLines: { color: "rgba(12,52,32,0.06)" },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(12,52,32,0.25)", labelBackgroundColor: BRAND },
        horzLine: { color: "rgba(12,52,32,0.25)", labelBackgroundColor: BRAND },
      },
      localization: { priceFormatter: (p: number) => fmtPrice(p) },
      handleScroll: { vertTouchDrag: false },
    });
    chart.current = c;

    const data = candles.map((k) => ({ ...k, time: k.time as UTCTimestamp }));
    const series =
      effective === "candles"
        ? c.addSeries(CandlestickSeries, {
            upColor: UP,
            downColor: DOWN,
            wickUpColor: UP,
            wickDownColor: DOWN,
            borderVisible: false,
          })
        : c.addSeries(AreaSeries, {
            lineColor: BRAND,
            lineWidth: 2,
            topColor: "rgba(15,107,63,0.22)",
            bottomColor: "rgba(15,107,63,0.0)",
          });
    if (effective === "candles") series.setData(data);
    else {
      /*
       * The line starts where the coin started: the launch price at the launch
       * block. A young coin with one or two bars otherwise draws a dot; with
       * this anchor it draws its whole path since launch, which is true data.
       */
      const line = data.map((k) => ({ time: k.time, value: k.close }));
      if (launchPrice != null && launchedAt != null && launchedAt < data[0].time) {
        line.unshift({ time: launchedAt as UTCTimestamp, value: launchPrice });
      }
      series.setData(line);
    }

    if (launchPrice != null && isFinite(launchPrice)) {
      series.createPriceLine({
        price: launchPrice,
        color: "rgba(12,52,32,0.35)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "launch",
      });
    }

    /* each engine event sits on the bar it landed in */
    const step = candles.length > 1 ? candles[1].time - candles[0].time : 900;
    const first = candles[0].time;
    const last = candles[candles.length - 1].time;
    // an event outside the bars (before the first swap bucket, or in the current
    // one) is pinned to the nearest bar rather than dropped: the header counts it
    const markers = events
      .map((e) => ({ e, t: Math.min(last, Math.max(first, Math.floor((e.ts - first) / step) * step + first)) }))
      .sort((a, b) => a.t - b.t)
      .map(({ e, t }) => ({
        time: t as UTCTimestamp,
        position: "belowBar" as const,
        color: BRAND,
        shape: (e.kind === "burn" ? "circle" : "arrowUp") as "circle" | "arrowUp",
        text: e.kind === "burn" ? "burn" : "buyback",
      }));
    if (markers.length) createSeriesMarkers(series, markers);

    c.timeScale().fitContent();
    return () => {
      c.remove();
      chart.current = null;
    };
  }, [candles, events, effective, launchPrice, launchedAt]);

  const tabs: { key: Mode; label: string }[] = [
    { key: "line", label: "Line" },
    { key: "candles", label: "Candles" },
    { key: "dex", label: "DexScreener" },
  ];

  return (
    <section className="overflow-hidden rounded-[18px] border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="font-display text-lg font-semibold">${symbol}</h2>
          {events.length > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <span className="size-2 rounded-full bg-brand" />
              {events.length} engine {events.length === 1 ? "event" : "events"} on the chart
            </span>
          )}
        </div>
        <div role="tablist" aria-label="Chart" className="flex rounded-lg bg-panel-2 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={effective === t.key}
              onClick={() => setMode(t.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                effective === t.key ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative h-[340px] sm:h-[460px]">
        {effective === "dex" ? (
          dexSrc ? (
            <iframe src={dexSrc} title={`${symbol} on DexScreener`} className="absolute inset-0 h-full w-full border-0" loading="lazy" />
          ) : (
            <ChartNote title="Not on DexScreener yet" body="It picks the pool up shortly after its first swap.">
              <a href={dexPage} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand underline underline-offset-4">
                Open DexScreener
              </a>
            </ChartNote>
          )
        ) : candles === null ? (
          <div className="absolute inset-4 animate-pulse rounded-[12px] bg-panel-2" />
        ) : candles.length === 0 ? (
          <ChartNote title="No trades yet" body="The chart starts with the pool's first swap." />
        ) : (
          <div ref={box} className="absolute inset-0 px-1 pt-2" />
        )}
      </div>
    </section>
  );
}

function ChartNote({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="font-display text-lg font-semibold text-ink">{title}</span>
      <span className="max-w-[360px] text-sm leading-relaxed text-ink-3">{body}</span>
      {children}
    </div>
  );
}
