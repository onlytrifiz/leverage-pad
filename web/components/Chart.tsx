"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  createTextWatermark,
  CandlestickSeries,
  type IChartApi,
} from "lightweight-charts";
import type { Candle } from "@/lib/types";

/**
 * Chart candele dal pool V3 (o serie demo). Colori mark validati:
 * up #16b14c / down #ad3a3a su #0a0c0a (gap di luminosita' per i CVD).
 * Griglia e assi recessivi, watermark ticker in stile terminale.
 */
export default function Chart({ address, symbol }: { address: string; symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [state, setState] = useState<"loading" | "empty" | "ready">("loading");

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#5c6a5e",
        fontFamily: "var(--font-plex-mono), monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#121812" },
        horzLines: { color: "#121812" },
      },
      rightPriceScale: { borderColor: "#1e281f" },
      timeScale: { borderColor: "#1e281f", timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: "#2c3d2e", labelBackgroundColor: "#131a14" },
        horzLine: { color: "#2c3d2e", labelBackgroundColor: "#131a14" },
      },
      localization: {
        priceFormatter: (p: number) => (p >= 1 ? p.toFixed(2) : p.toPrecision(4)),
      },
    });
    chartRef.current = chart;
    createTextWatermark(chart.panes()[0], {
      horzAlign: "center",
      vertAlign: "center",
      lines: [{ text: `$${symbol}`, color: "rgba(46, 224, 107, 0.05)", fontSize: 72, fontStyle: "bold" }],
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#16b14c",
      downColor: "#ad3a3a",
      borderUpColor: "#16b14c",
      borderDownColor: "#ad3a3a",
      wickUpColor: "#16b14c",
      wickDownColor: "#ad3a3a",
      priceFormat: { type: "price", precision: 10, minMove: 1e-10 },
    });

    let cancelled = false;
    fetch(`/api/coin/${address}/candles`)
      .then((r) => r.json())
      .then(({ candles }: { candles: Candle[] }) => {
        if (cancelled) return;
        if (!candles?.length) {
          setState("empty");
          return;
        }
        series.setData(candles.map((c) => ({ ...c, time: c.time as never })));
        chart.timeScale().fitContent();
        setState("ready");
      })
      .catch(() => !cancelled && setState("empty"));

    return () => {
      cancelled = true;
      chart.remove();
      chartRef.current = null;
    };
  }, [address, symbol]);

  return (
    <div className="panel overflow-hidden">
      <div className="panel-head">
        <span className="lbl">${symbol} · token chart</span>
        <span className="lbl">uniswap v3 · on-chain</span>
      </div>
      <div className="relative h-[380px]">
        <div ref={ref} className="absolute inset-0" />
        {state !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="lbl">
              {state === "loading" ? "loading swaps…" : "no trades yet — chart appears with the first swap"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
