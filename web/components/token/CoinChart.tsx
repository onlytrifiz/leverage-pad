"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LastPriceAnimationMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { ArrowUpRight, ChartCandlestick, ChartSpline } from "lucide-react";
import { cn } from "cn";
import type { ChartData, Resolution } from "@/lib/types";
import { RESOLUTIONS } from "@/lib/resolutions";
import AssetIcon from "@/components/AssetIcon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ARROW_PATH, HatchLayer, MarksLayer, placeBuybacks, placeLines } from "./chart-marks";

/**
 * The token's chart, as the story it tells: the market the engine trades on top, the token under it,
 * one time axis. A buyback is marked where it landed, and a dated line runs through both where the
 * engine changed. Quiet stretches are drawn flat, because a token nobody trades while its market
 * moves is what the engine is for.
 *
 * Printed like the notes: the line stands on engraved strokes, a rising candle is hollow and a
 * falling one solid, so direction never hangs on telling green from red.
 *
 * DexScreener is one tab away, and is what shows when our data does not answer.
 */

const LINE = "#0f6b3f";
const UP = "#1f8f5f";
const DOWN = "#b3261e";
const ASSET = "#3b6fb5";
const INK = "#0c3420";
const MINT = "#8ce8b0";
const AXIS = "#566c5e";
const PAPER = "#ffffff";
const GRID = "rgba(12,52,32,0.05)";
const VOLUME = "rgba(12,52,32,0.13)";

const HEIGHT = "h-[380px] sm:h-[470px]";
const POLL_MS = 5_000;
/** narrower than this, a tooltip beside the cursor runs off the chart */
const TOOLTIP_BESIDE = 480;

type Style = "line" | "candles";
type Unit = "mcap" | "price";
type View = "chart" | "dex";

/** a choice kept in this browser; the server renders the default */
function usePref<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const value = useSyncExternalStore<T>(
    (notify) => {
      window.addEventListener("multiply:pref", notify);
      window.addEventListener("storage", notify);
      return () => {
        window.removeEventListener("multiply:pref", notify);
        window.removeEventListener("storage", notify);
      };
    },
    () => {
      try {
        const v = localStorage.getItem(key) as T | null;
        return v && allowed.includes(v) ? v : fallback;
      } catch {
        return fallback;
      }
    },
    () => fallback
  );
  const set = useCallback(
    (v: T) => {
      try {
        localStorage.setItem(key, v);
      } catch {
        /* private mode: the choice lasts as long as the page */
      }
      window.dispatchEvent(new Event("multiply:pref"));
    },
    [key]
  );
  return [value, set] as const;
}

/** four significant digits, compact above a thousand: rounder prints the same axis label three times on a tight range */
function sig(n: number): string {
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1) return new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 }).format(n);
  if (a >= 0.001) return n.toPrecision(4);
  // 0.000004013 → 0.0₅4013: how every terminal writes it, and the only form that fits the axis
  const zeros = -Math.floor(Math.log10(a)) - 1;
  const sub = [...String(zeros)].map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)]).join("");
  return `${n < 0 ? "−" : ""}0.0${sub}${Math.round(a * 10 ** (zeros + 4))}`;
}
const usd = (n: number) => `$${sig(n)}`;
const plain = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 5 })}`;
const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(2)}%`;

const firstResolution = (ageS: number): Resolution => (ageS < 6 * 3600 ? "1m" : ageS < 3 * 86_400 ? "5m" : "1h");

export default function CoinChart({
  address,
  symbol,
  supply,
  ageS,
  dexSrc,
  dexPage,
}: {
  address: string;
  symbol: string;
  /** live supply: market cap = price × this. Null shows the price. */
  supply: number | null;
  /** seconds since the launch, when the page was made */
  ageS: number;
  /** null when DexScreener has not indexed the pool yet */
  dexSrc: string | null;
  dexPage: string;
}) {
  const [style, setStyle] = usePref<Style>("multiply.chart.style", ["line", "candles"], "line");
  const [unitPref, setUnit] = usePref<Unit>("multiply.chart.unit", ["mcap", "price"], "mcap");
  const [res, setRes] = useState<Resolution>(() => firstResolution(ageS));
  const [view, setView] = useState<View | null>(null);
  const [loaded, setLoaded] = useState<{ res: Resolution; data: ChartData } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      // a tab nobody is looking at asks for nothing
      if (!document.hidden) {
        try {
          const r = await fetch(`/api/coin/${address}/chart?res=${res}`, { signal: stop.signal });
          if (!r.ok) throw new Error(String(r.status));
          const data = (await r.json()) as ChartData;
          setLoaded({ res, data });
          setFailed(false);
        } catch {
          if (stop.signal.aborted) return;
          setFailed(true);
        }
      }
      timer = setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [address, res, retry]);

  const unit: Unit = supply == null ? "price" : unitPref;
  // the old series stays on screen, dimmed, until the new one arrives
  const dimmed = loaded != null && loaded.res !== res;
  const lost = failed && loaded == null;
  const shown: View = view ?? (lost && dexSrc ? "dex" : "chart");

  return (
    <section aria-label={`${symbol} chart`} className="relative overflow-hidden rounded-[18px] border border-line bg-panel">
      {/* the source, as quiet text in the corner: the figure is the header */}
      <div className="absolute top-4 right-4 z-10 flex gap-3 text-xs sm:right-5">
        <Tab on={shown === "chart"} onClick={() => setView("chart")}>
          Chart
        </Tab>
        <Tab on={shown === "dex"} onClick={() => setView("dex")}>
          DexScreener
        </Tab>
      </div>

      {shown === "dex" ? (
        <div className="relative mt-12 h-[420px] border-t border-line sm:h-[520px]">
          {dexSrc ? (
            <iframe src={dexSrc} title={`${symbol} on DexScreener`} className="absolute inset-0 h-full w-full border-0" loading="lazy" />
          ) : (
            <Note title="Not on DexScreener yet" body="It picks the pool up shortly after its first swap.">
              <a href={dexPage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                Open DexScreener <ArrowUpRight size={14} aria-hidden />
              </a>
            </Note>
          )}
        </div>
      ) : lost ? (
        <div className={cn("relative", HEIGHT)}>
          <Note title="The chart could not be loaded" body="Trades are still happening; try again in a moment.">
            <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
              Try again
            </Button>
          </Note>
        </div>
      ) : !loaded ? (
        <div className="p-5 pt-14">
          <Skeleton className={cn("w-full", HEIGHT)} />
        </div>
      ) : loaded.data.candles.length === 0 ? (
        <div className={cn("relative", HEIGHT)}>
          <Note title="No trades yet" body="The chart starts with the pool's first swap." />
        </div>
      ) : (
        <Plot
          data={loaded.data}
          res={loaded.res}
          scale={unit === "mcap" ? (supply ?? 1) : 1}
          unit={unit}
          onUnit={supply == null ? undefined : setUnit}
          style={style}
          dimmed={dimmed}
          stale={failed}
          symbol={symbol}
        />
      )}

      {shown === "chart" && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 sm:px-5">
          <div role="radiogroup" aria-label="Candle size" className="flex min-w-0">
            {(Object.keys(RESOLUTIONS) as Resolution[]).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={res === r}
                onClick={() => setRes(r)}
                className={cn(
                  "num -mt-px h-11 min-w-9 border-t-2 px-1.5 text-xs transition-colors max-[359px]:min-w-8 max-[359px]:px-1 sm:min-w-10",
                  res === r ? "border-brand font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink"
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStyle(style === "line" ? "candles" : "line")}
            className="inline-flex size-11 shrink-0 items-center justify-center text-ink-3 transition-colors hover:text-ink"
            aria-label={style === "line" ? "Show candles" : "Show a line"}
            title={style === "line" ? "Show candles" : "Show a line"}
          >
            {style === "line" ? <ChartCandlestick size={18} aria-hidden /> : <ChartSpline size={18} aria-hidden />}
          </button>
        </div>
      )}
    </section>
  );
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("py-1 transition-colors", on ? "font-semibold text-ink underline decoration-brand decoration-2 underline-offset-[5px]" : "text-ink-3 hover:text-ink")}
    >
      {children}
    </button>
  );
}

function Note({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="font-display text-lg font-semibold text-ink">{title}</span>
      <span className="max-w-[360px] text-sm leading-relaxed text-ink-3">{body}</span>
      {children}
    </div>
  );
}

function Plot({
  data,
  res,
  scale,
  unit,
  onUnit,
  style,
  dimmed,
  stale,
  symbol,
}: {
  data: ChartData;
  res: Resolution;
  scale: number;
  unit: Unit;
  /** absent when there is only a price to show */
  onUnit?: (u: Unit) => void;
  style: Style;
  dimmed: boolean;
  stale: boolean;
  symbol: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const bars = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const line = useRef<ISeriesApi<"Line"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const asset = useRef<ISeriesApi<"Line"> | null>(null);
  const hatch = useRef<HatchLayer | null>(null);
  const marks = useRef<MarksLayer | null>(null);
  const assetMarks = useRef<MarksLayer | null>(null);
  const seconds = useRef(false);
  const framed = useRef<string | null>(null);
  const mono = useRef("monospace");
  const [hover, setHover] = useState<{ time: number; x: number; y: number; w: number; h: number } | null>(null);
  /** top of the token's pane: where the asset's ends */
  const [split, setSplit] = useState(0);

  const asLine = style === "line";
  const { candles } = data;
  const series = useMemo(
    () =>
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open * scale,
        high: c.high * scale,
        low: c.low * scale,
        close: c.close * scale,
        volume: c.volume ?? 0,
        up: c.close >= c.open,
      })),
    [candles, scale]
  );
  const buybacks = useMemo(() => placeBuybacks(candles, scale, asLine, data.marks), [candles, scale, asLine, data.marks]);
  const lines = useMemo(() => placeLines(candles, data.lines), [candles, data.lines]);
  const hasAsset = data.asset != null;

  // made once; everything below pushes into it
  useEffect(() => {
    const el = box.current!;
    mono.current = getComputedStyle(document.body).getPropertyValue("--font-plex-mono").trim() || "monospace";
    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: AXIS,
        fontFamily: mono.current,
        fontSize: 11,
        // the library's licence asks for TradingView's attribution; its own logo is the intended way
        attributionLogo: true,
        panes: { separatorColor: "rgba(12,52,32,0.12)", separatorHoverColor: "rgba(12,52,32,0.12)", enableResize: false },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: GRID } },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        // local time on the axis and on the crosshair: the library's default is UTC
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const d = new Date((t as number) * 1000);
          if (type === TickMarkType.Year) return String(d.getFullYear());
          if (type === TickMarkType.Month) return d.toLocaleString("en-US", { month: "short" });
          if (type === TickMarkType.DayOfMonth) return d.toLocaleString("en-US", { month: "short", day: "numeric" });
          return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: type === TickMarkType.TimeWithSeconds ? "2-digit" : undefined });
        },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(12,52,32,0.35)", width: 1, style: LineStyle.Dotted, labelBackgroundColor: INK },
        horzLine: { color: "rgba(12,52,32,0.35)", width: 1, style: LineStyle.Dotted, labelBackgroundColor: INK },
      },
      localization: {
        priceFormatter: usd,
        timeFormatter: (t: Time) =>
          new Date((t as number) * 1000).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: seconds.current ? "2-digit" : undefined }),
      },
      handleScroll: { vertTouchDrag: false },
    });
    chart.current = c;
    const priceFormat = { type: "custom" as const, formatter: usd, minMove: 1e-12 };
    // volume behind the token, on a scale of its own with no axis: a texture, not a second measure to read
    volume.current = c.addSeries(HistogramSeries, { color: VOLUME, priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "custom", formatter: usd, minMove: 0.01 } });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    bars.current = c.addSeries(CandlestickSeries, { upColor: PAPER, borderUpColor: UP, wickUpColor: UP, downColor: DOWN, borderDownColor: DOWN, wickDownColor: DOWN, priceLineColor: LINE, priceLineStyle: LineStyle.Dotted, priceFormat });
    line.current = c.addSeries(LineSeries, { color: LINE, lineWidth: 2, priceLineColor: LINE, priceLineStyle: LineStyle.Dotted, priceFormat });
    // room for the labels and the buybacks over the highs, and for the volume underneath
    line.current.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0.18 } });
    hatch.current = new HatchLayer("rgba(15,107,63,0.42)");
    marks.current = new MarksLayer({ ink: INK, mint: MINT, axis: AXIS, paper: PAPER, font: mono.current }, true);
    assetMarks.current = new MarksLayer({ ink: INK, mint: MINT, axis: AXIS, paper: PAPER, font: mono.current }, false);
    const move = (p: MouseEventParams) =>
      setHover(typeof p.time === "number" && p.point ? { time: p.time, x: p.point.x, y: p.point.y, w: el.clientWidth, h: el.clientHeight } : null);
    c.subscribeCrosshairMove(move);
    return () => {
      c.unsubscribeCrosshairMove(move);
      c.remove();
      chart.current = null;
      asset.current = null;
      framed.current = null;
    };
  }, []);

  useEffect(() => {
    seconds.current = res === "1s";
    chart.current?.applyOptions({ timeScale: { secondsVisible: res === "1s" } });
  }, [res]);

  // the market's own pane, on top; gone when there is nothing to draw in it
  useEffect(() => {
    const c = chart.current;
    if (!c || !hasAsset) return;
    const s = c.addSeries(
      LineSeries,
      { color: ASSET, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "custom", formatter: plain, minMove: 1e-9 } },
      1
    );
    s.priceScale().applyOptions({ scaleMargins: { top: 0.34, bottom: 0.12 } });
    s.moveToPane(1);
    c.panes()[1].moveTo(0);
    c.panes()[0].setStretchFactor(0.3);
    c.panes()[1].setStretchFactor(0.7);
    if (assetMarks.current) s.attachPrimitive(assetMarks.current);
    asset.current = s;
    return () => {
      asset.current = null;
      if (chart.current) {
        c.removeSeries(s);
        setSplit(0);
      }
    };
  }, [hasAsset]);

  useEffect(() => {
    bars.current?.setData(series.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    // the line starts where the token did: one bar before its first trade, at the launch price
    const start = data.complete && series.length ? [{ time: (series[0].time - RESOLUTIONS[res]) as UTCTimestamp, value: data.launchPrice * scale }] : [];
    const pts = [...start, ...series.map((s) => ({ time: s.time, value: s.close }))];
    line.current?.setData(pts);
    hatch.current?.set(pts);
    volume.current?.setData(series.map((s) => ({ time: s.time, value: s.volume })));
    asset.current?.setData((data.asset?.points ?? []).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    const c = chart.current;
    if (c && hasAsset) requestAnimationFrame(() => chart.current && setSplit(chart.current.panes()[0]?.getHeight() ?? 0));
  }, [series, data.complete, data.launchPrice, data.asset, hasAsset, res, scale]);

  // one series on screen; the glyphs ride on it
  useEffect(() => {
    bars.current?.applyOptions({ visible: !asLine });
    const pulse = asLine && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    line.current?.applyOptions({ visible: asLine, lastPriceAnimation: pulse ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled });
    const on = asLine ? line.current : bars.current;
    const m = marks.current;
    const h = hatch.current;
    if (!on || !m || !h) return;
    on.attachPrimitive(m);
    if (asLine) on.attachPrimitive(h);
    return () => {
      // the chart's own cleanup may have taken its series with it
      if (!chart.current) return;
      on.detachPrimitive(m);
      if (asLine) on.detachPrimitive(h);
    };
  }, [asLine]);

  useEffect(() => {
    marks.current?.set(buybacks, lines);
    assetMarks.current?.set([], lines);
  }, [buybacks, lines, asLine, hasAsset]);

  const ath = data.ath == null ? null : data.ath * scale;
  useEffect(() => {
    const on = asLine ? line.current : bars.current;
    if (!on || ath == null) return;
    const drawn = on.createPriceLine({ price: ath, color: AXIS, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "ATH" });
    return () => {
      if (chart.current) on.removePriceLine(drawn);
    };
  }, [asLine, ath]);

  // A new size of candle is framed once: a young token from its launch on the left with room to grow,
  // an older one at a fixed width against the right edge. A refresh leaves the view where the reader put it.
  useEffect(() => {
    const c = chart.current;
    if (!c || dimmed || framed.current === res || !series.length) return;
    framed.current = res;
    const fits = Math.floor(Math.max(200, (box.current?.clientWidth ?? 600) - 70) / 7);
    if (series.length < fits) {
      c.timeScale().setVisibleLogicalRange({ from: -1, to: Math.max(24, Math.min(fits, series.length * 1.15 + 2)) });
    } else {
      c.timeScale().applyOptions({ barSpacing: 7 });
      c.timeScale().scrollToRealTime();
    }
  }, [res, dimmed, series]);

  const last = series[series.length - 1];
  const at = (hover && series.find((s) => s.time === hover.time)) || last;
  const sinceLaunch = data.launchPrice > 0 ? at.close / (data.launchPrice * scale) - 1 : 0;
  const here = hover ? buybacks.find((b) => b.time === hover.time) : undefined;
  const assetAt = data.asset ? ((hover && data.asset.points.find((p) => p.time === hover.time)) ?? data.asset.points[data.asset.points.length - 1]) : null;
  const assetMove = data.asset && assetAt ? assetAt.value / data.asset.points[0].value - 1 : 0;
  const beside = hover != null && hover.w >= TOOLTIP_BESIDE;

  return (
    <div>
      <div className="px-4 pt-4 pb-3 sm:px-5">
        {onUnit ? (
          <button
            type="button"
            onClick={() => onUnit(unit === "mcap" ? "price" : "mcap")}
            title={unit === "mcap" ? "Show the price" : "Show the market cap"}
            className="inline-flex items-center gap-1 text-xs text-ink-3 underline decoration-line-2 decoration-dotted underline-offset-4 transition-colors hover:text-ink"
          >
            ${symbol} {unit === "mcap" ? "market cap" : "price"}
          </button>
        ) : (
          <span className="text-xs text-ink-3">${symbol} price</span>
        )}
        {/* fixed widths: figures that reflow under a moving cursor slide the chart with them */}
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
          <span className="num min-w-[7ch] font-display text-3xl leading-none font-bold tracking-[-0.03em] text-ink sm:text-4xl">{usd(at.close)}</span>
          <span className={cn("num min-w-[17ch] text-sm font-medium", sinceLaunch >= 0 ? "text-up" : "text-down")}>
            {pct(sinceLaunch)} <span className="font-normal text-ink-3">since launch</span>
          </span>
          <span className="num min-w-[13ch] text-sm text-ink-3">
            vol <span className="text-ink">{usd(at.volume)}</span>
          </span>
          {ath != null && (
            <span className="num text-sm text-ink-3">
              ATH <span className="text-ink">{usd(ath)}</span>
            </span>
          )}
          {stale && <span className="text-xs text-down">Reconnecting</span>}
        </div>
      </div>

      <div className="relative">
        <div
          ref={box}
          role="img"
          aria-label={`${symbol} ${unit === "mcap" ? "market cap" : "price"}, ${asLine ? "line" : "candles"}, ${res}, latest ${usd(last.close)}. The live feed below lists every trade.`}
          className={cn("w-full transition-opacity motion-reduce:transition-none", HEIGHT, dimmed && "opacity-45")}
        />
        {data.asset && assetAt && (
          <div className="pointer-events-none absolute top-1.5 left-4 flex items-center gap-1.5 rounded bg-panel/85 pr-1.5 text-xs sm:left-5">
            <AssetIcon symbol={data.asset.symbol} size={15} />
            <span className="font-semibold text-ink">{data.asset.symbol}</span>
            <span aria-hidden className="h-0.5 w-3.5 rounded-full" style={{ background: ASSET }} />
            <span className="num text-ink">{plain(assetAt.value)}</span>
            <span className={cn("num", assetMove >= 0 ? "text-up" : "text-down")}>{pct(assetMove)}</span>
          </div>
        )}
        {data.asset && split > 0 && (
          <div className="pointer-events-none absolute right-[78px] flex items-center gap-1.5 rounded bg-panel/85 px-1.5 text-xs" style={{ top: split + 7 }}>
            <span aria-hidden className="h-0.5 w-3.5 rounded-full" style={{ background: asLine ? LINE : UP }} />
            <span className="font-semibold text-ink">${symbol}</span>
          </div>
        )}
        {hover && here && (
          <div
            aria-hidden
            className="num pointer-events-none absolute z-10 rounded-lg border border-line bg-panel px-2.5 py-2 text-xs whitespace-nowrap text-ink-3 shadow-[0_10px_28px_-14px_rgba(12,52,32,0.5)]"
            style={
              beside
                ? { top: Math.min(Math.max(hover.y - 56, 8), hover.h - 60), ...(hover.w - hover.x < hover.x ? { right: hover.w - hover.x + 14 } : { left: hover.x + 14 }) }
                : { top: split + 8, left: 8 }
            }
          >
            <b className="font-semibold text-ink">{usd(here.usd)}</b> buyback, {sig(here.tokens)} burned
          </div>
        )}
      </div>

      {buybacks.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 pb-3 text-xs text-ink-3 sm:px-5">
          <svg viewBox="-9 -9 18 18" className="size-4" aria-hidden>
            <circle r="9" fill={INK} />
            <path d={ARROW_PATH} transform="scale(0.62)" fill={MINT} />
          </svg>
          The engine bought and burned
        </div>
      )}
    </div>
  );
}
