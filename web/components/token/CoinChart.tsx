"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LastPriceAnimationMode,
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
import { useWallet } from "@/components/wallet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ARROW_PATH, ChartMarksLayer, placeLines, stackMarks } from "./chart-marks";

/**
 * The token's own chart, drawn from its pool's swaps, with the engine on it.
 *
 * DexScreener draws the price; only this one can draw why it moved: the engine's buybacks, the
 * changes of engine, the connected wallet's own trades and its average entry. A rising candle is
 * hollow and a falling one is solid, so direction never hangs on telling green from red.
 *
 * DexScreener is one tab away, and what is shown when our data does not answer.
 */

const UP = "#1f8f5f";
const DOWN = "#b3261e";
const INK = "#0c3420";
const AXIS = "#566c5e";
const PAPER = "#ffffff";
const VOLUME = "#bacfbe";
const GRID = "rgba(12,52,32,0.055)";

const HEIGHT = "h-[340px] sm:h-[420px]";
/** narrower than this, a tooltip beside the cursor runs off the chart */
const TOOLTIP_BESIDE = 480;
const POLL_MS = 5_000;

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
  const { address: wallet } = useWallet();
  const [style, setStyle] = usePref<Style>("multiply.chart.style", ["line", "candles"], "line");
  const [unitPref, setUnit] = usePref<Unit>("multiply.chart.unit", ["mcap", "price"], "mcap");
  const [res, setRes] = useState<Resolution>(() => firstResolution(ageS));
  const [view, setView] = useState<View | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; res: Resolution; data: ChartData } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  const key = `${address}:${res}:${wallet ?? ""}`;
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      // a tab nobody is looking at asks for nothing
      if (!document.hidden) {
        try {
          const r = await fetch(`/api/coin/${address}/chart?res=${res}${wallet ? `&trader=${wallet}` : ""}`, { signal: stop.signal });
          if (!r.ok) throw new Error(String(r.status));
          const data = (await r.json()) as ChartData;
          setLoaded({ key, res, data });
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
  }, [address, res, wallet, key, retry]);

  const unit: Unit = supply == null ? "price" : unitPref;
  const scale = unit === "mcap" ? (supply ?? 1) : 1;
  // the old series stays on screen, dimmed, until the new one arrives
  const dimmed = loaded != null && loaded.key !== key;
  const lost = failed && loaded == null;
  const shown: View = view ?? (lost && dexSrc ? "dex" : "chart");

  return (
    <section aria-labelledby="chart-title" className="overflow-hidden rounded-[18px] border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <h2 id="chart-title" className="font-display text-lg font-semibold">
            ${symbol}
          </h2>
          {supply != null && shown === "chart" && (
            <Choice label="Unit" value={unit} onChange={setUnit} items={[{ value: "mcap", text: "MCap" }, { value: "price", text: "Price" }]} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {shown === "chart" && (
            <Choice
              label="Chart style"
              value={style}
              onChange={setStyle}
              items={[
                { value: "line", text: "Line", icon: <ChartSpline aria-hidden /> },
                { value: "candles", text: "Candles", icon: <ChartCandlestick aria-hidden /> },
              ]}
            />
          )}
          <Choice
            label="Source"
            value={shown}
            onChange={setView}
            items={[
              { value: "chart", text: "Chart" },
              { value: "dex", text: "DexScreener" },
            ]}
          />
        </div>
      </div>

      {shown === "dex" ? (
        <div className="relative h-[420px] sm:h-[520px]">
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
      ) : (
        <>
          <div className="flex items-center border-b border-line px-4 py-2 sm:px-5">
            <Choice
              label="Candle size"
              value={res}
              onChange={setRes}
              mono
              items={(Object.keys(RESOLUTIONS) as Resolution[]).map((r) => ({ value: r, text: r }))}
            />
          </div>
          {lost ? (
            <div className={cn("relative", HEIGHT)}>
              <Note title="The chart could not be loaded" body="Trades are still happening; try again in a moment.">
                <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
                  Try again
                </Button>
              </Note>
            </div>
          ) : !loaded ? (
            <div className="p-4">
              <Skeleton className={cn("w-full", HEIGHT)} />
            </div>
          ) : loaded.data.candles.length === 0 ? (
            <div className={cn("relative", HEIGHT)}>
              <Note title="No trades yet" body="The chart starts with the pool's first swap." />
            </div>
          ) : (
            <Plot data={loaded.data} res={loaded.res} scale={scale} unit={unit} style={style} dimmed={dimmed} stale={failed} symbol={symbol} />
          )}
        </>
      )}
    </section>
  );
}

function Choice<T extends string>({
  label,
  value,
  onChange,
  items,
  mono = false,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  items: { value: T; text: string; icon?: React.ReactNode }[];
  mono?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
      value={[value]}
      // pressing the one already on would clear it: one is always chosen
      onValueChange={(v: unknown[]) => v[0] != null && onChange(v[0] as T)}
    >
      {items.map((i) => (
        <ToggleGroupItem
          key={i.value}
          value={i.value}
          className={cn("text-xs text-ink-3 aria-pressed:bg-brand-soft aria-pressed:text-brand", mono && "num min-w-9 max-[389px]:min-w-8 max-[389px]:px-1")}
        >
          {i.icon}
          <span className={i.icon ? "max-[389px]:sr-only" : undefined}>{i.text}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
  style,
  dimmed,
  stale,
  symbol,
}: {
  data: ChartData;
  res: Resolution;
  scale: number;
  unit: Unit;
  style: Style;
  dimmed: boolean;
  stale: boolean;
  symbol: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const bars = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const layer = useRef<ChartMarksLayer | null>(null);
  const seconds = useRef(false);
  const framed = useRef<string | null>(null);
  const [hover, setHover] = useState<{ time: number; x: number; y: number; w: number; h: number } | null>(null);

  const line = style === "line";
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
        trades: c.trades ?? 0,
      })),
    [candles, scale]
  );
  const stacks = useMemo(() => stackMarks(candles, scale, line, data.marks), [candles, scale, line, data.marks]);
  const lines = useMemo(() => placeLines(candles, data.lines), [candles, data.lines]);

  // made once; everything below pushes into it
  useEffect(() => {
    const el = box.current!;
    const mono = getComputedStyle(document.body).getPropertyValue("--font-plex-mono").trim() || "monospace";
    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: AXIS,
        fontFamily: mono,
        fontSize: 11,
        // the library's licence asks for TradingView's attribution; its own logo is the intended way
        attributionLogo: true,
        panes: { separatorColor: "rgba(12,52,32,0.1)", separatorHoverColor: "rgba(12,52,32,0.1)", enableResize: false },
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        // local time on the axis and on the crosshair: the library's default is UTC
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const d = new Date((t as number) * 1000);
          if (type === TickMarkType.Year) return String(d.getFullYear());
          if (type === TickMarkType.Month) return d.toLocaleString("en-US", { month: "short" });
          if (type === TickMarkType.DayOfMonth) return d.toLocaleString("en-US", { month: "short", day: "numeric" });
          return d.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            second: type === TickMarkType.TimeWithSeconds ? "2-digit" : undefined,
          });
        },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(12,52,32,0.3)", width: 1, style: LineStyle.Solid, labelBackgroundColor: INK },
        horzLine: { color: "rgba(12,52,32,0.3)", width: 1, style: LineStyle.Solid, labelBackgroundColor: INK },
      },
      localization: {
        priceFormatter: usd,
        timeFormatter: (t: Time) =>
          new Date((t as number) * 1000).toLocaleString("en-GB", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: seconds.current ? "2-digit" : undefined,
          }),
      },
      handleScroll: { vertTouchDrag: false },
    });
    const priceFormat = { type: "custom" as const, formatter: usd, minMove: 1e-12 };
    bars.current = c.addSeries(CandlestickSeries, {
      upColor: PAPER,
      borderUpColor: UP,
      wickUpColor: UP,
      downColor: DOWN,
      borderDownColor: DOWN,
      wickDownColor: DOWN,
      priceLineColor: AXIS,
      priceLineStyle: LineStyle.Solid,
      priceFormat,
    });
    area.current = c.addSeries(AreaSeries, {
      lineColor: UP,
      lineWidth: 2,
      topColor: "rgba(31,143,95,0.22)",
      bottomColor: "rgba(31,143,95,0)",
      priceLineColor: AXIS,
      priceLineStyle: LineStyle.Solid,
      priceFormat,
    });
    // room for the glyphs over the highs and under the lows
    bars.current.priceScale().applyOptions({ scaleMargins: { top: 0.18, bottom: 0.12 } });
    volume.current = c.addSeries(
      HistogramSeries,
      { color: VOLUME, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "custom", formatter: usd, minMove: 0.01 } },
      1
    );
    c.panes()[0].setStretchFactor(0.8);
    c.panes()[1].setStretchFactor(0.2);
    layer.current = new ChartMarksLayer({ up: UP, down: DOWN, ink: INK, axis: AXIS, paper: PAPER, font: mono });
    const move = (p: MouseEventParams) =>
      setHover(typeof p.time === "number" && p.point ? { time: p.time, x: p.point.x, y: p.point.y, w: el.clientWidth, h: el.clientHeight } : null);
    c.subscribeCrosshairMove(move);
    chart.current = c;
    return () => {
      c.unsubscribeCrosshairMove(move);
      c.remove();
      chart.current = null;
      framed.current = null;
    };
  }, []);

  useEffect(() => {
    seconds.current = res === "1s";
    chart.current?.applyOptions({ timeScale: { secondsVisible: res === "1s" } });
  }, [res]);

  useEffect(() => {
    bars.current?.setData(series);
    // the line starts where the token did: one bar before its first trade, at the launch price
    const start = data.complete && series.length ? [{ time: (series[0].time - RESOLUTIONS[res]) as UTCTimestamp, value: data.launchPrice * scale }] : [];
    area.current?.setData([...start, ...series.map((s) => ({ time: s.time, value: s.close }))]);
    volume.current?.setData(series.map((s) => ({ time: s.time, value: s.volume })));
  }, [series, data.complete, data.launchPrice, res, scale]);

  // one series on screen; the glyphs ride on it
  useEffect(() => {
    bars.current?.applyOptions({ visible: !line });
    const pulse = line && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    area.current?.applyOptions({ visible: line, lastPriceAnimation: pulse ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled });
    const active = line ? area.current : bars.current;
    const marks = layer.current;
    if (!active || !marks) return;
    active.attachPrimitive(marks);
    return () => {
      // the chart's own cleanup may have taken its series with it
      if (chart.current) active.detachPrimitive(marks);
    };
  }, [line]);

  useEffect(() => {
    layer.current?.set(stacks, lines);
  }, [stacks, lines, line]);

  const ath = data.ath == null ? null : data.ath * scale;
  const entry = data.entry == null ? null : data.entry * scale;
  useEffect(() => {
    const active = line ? area.current : bars.current;
    if (!active) return;
    const drawn = [
      ath == null ? null : active.createPriceLine({ price: ath, color: AXIS, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "ATH" }),
      entry == null ? null : active.createPriceLine({ price: entry, color: INK, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Your entry" }),
    ];
    return () => {
      if (!chart.current) return;
      for (const l of drawn) if (l) active.removePriceLine(l);
    };
  }, [line, ath, entry]);

  // A new size of candle is framed once: a young token from its launch on the left with room to grow,
  // an older one at a fixed width against the right edge. A refresh leaves the view where the reader put it.
  useEffect(() => {
    const c = chart.current;
    if (!c || dimmed || framed.current === res || !series.length) return;
    framed.current = res;
    const fits = Math.floor(Math.max(200, (box.current?.clientWidth ?? 600) - 70) / 9);
    if (series.length < fits) {
      c.timeScale().setVisibleLogicalRange({ from: -1, to: Math.max(24, Math.min(fits, series.length * 1.25 + 2)) });
    } else {
      c.timeScale().applyOptions({ barSpacing: 9 });
      c.timeScale().scrollToRealTime();
    }
  }, [res, dimmed, series]);

  const at = (hover && series.find((s) => s.time === hover.time)) || series[series.length - 1];
  const change = at.open > 0 ? at.close / at.open - 1 : 0;
  const here = hover ? stacks.find((m) => m.time === hover.time) : undefined;
  const hasBuyback = stacks.some((m) => m.buyback);
  const hasMine = stacks.some((m) => m.bought || m.sold);
  const beside = hover != null && hover.w >= TOOLTIP_BESIDE;

  return (
    <div>
      {/* fixed widths: a readout that reflows under a moving cursor slides the chart with it */}
      <dl className="num flex min-h-[58px] flex-wrap content-center items-baseline gap-x-5 gap-y-1 px-4 py-2.5 text-xs text-ink-3 sm:min-h-[42px] sm:px-5">
        <div className="flex items-baseline gap-2">
          <dt className="sr-only">{unit === "mcap" ? "Market cap" : "Price"}</dt>
          <dd className="min-w-[8ch] text-base font-semibold text-ink">{usd(at.close)}</dd>
          <dd className={cn("min-w-[8ch]", change >= 0 ? "text-up" : "text-down")}>
            {change >= 0 ? "+" : "−"}
            {Math.abs(change * 100).toFixed(2)}%
          </dd>
        </div>
        <Figure k="H" v={usd(at.high)} />
        <Figure k="L" v={usd(at.low)} />
        <Figure k="Vol" v={usd(at.volume)} />
        <Figure k="Trades" v={String(at.trades)} w="min-w-[3ch]" />
        {ath != null && <Figure k="ATH" v={usd(ath)} />}
        {entry != null && <Figure k="Your entry" v={usd(entry)} />}
        {stale && <span className="ml-auto text-down">Reconnecting</span>}
      </dl>

      <div className="relative">
        <div
          ref={box}
          role="img"
          aria-label={`${symbol} ${unit === "mcap" ? "market cap" : "price"}, ${line ? "line" : "candles"}, ${res}, latest ${usd(series[series.length - 1].close)}. The live feed below lists every trade.`}
          className={cn("w-full transition-opacity motion-reduce:transition-none", HEIGHT, dimmed && "opacity-45")}
        />
        {hover && here && (
          <div
            aria-hidden
            className="num pointer-events-none absolute z-10 flex flex-col gap-0.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-xs whitespace-nowrap text-ink-3 shadow-[0_10px_28px_-14px_rgba(12,52,32,0.5)]"
            style={
              beside
                ? {
                    top: Math.min(Math.max(hover.y - 70, 8), hover.h - 84),
                    ...(hover.w - hover.x < hover.x ? { right: hover.w - hover.x + 14 } : { left: hover.x + 14 }),
                  }
                : { top: 8, left: 8 }
            }
          >
            {here.buyback && (
              <span>
                <b className="font-semibold text-ink">{usd(here.buyback.usd)}</b> buyback, {sig(here.buyback.tokens)} burned
              </span>
            )}
            {here.bought != null && (
              <span>
                <b className="font-semibold text-ink">{usd(here.bought)}</b> you bought
              </span>
            )}
            {here.sold != null && (
              <span>
                <b className="font-semibold text-ink">{usd(here.sold)}</b> you sold
              </span>
            )}
          </div>
        )}
      </div>

      {(hasBuyback || hasMine) && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-ink-3 sm:px-5">
          {hasBuyback && (
            <span className="flex items-center gap-1.5">
              <svg viewBox="-9 -9 18 18" className="size-4" aria-hidden>
                <circle r="9" fill={INK} />
                <path d={ARROW_PATH} transform="scale(0.62)" fill="#8ce8b0" />
              </svg>
              Buyback and burn
            </span>
          )}
          {hasMine && (
            <span className="flex items-center gap-1.5">
              <Letter c={UP}>B</Letter>
              <Letter c={DOWN}>S</Letter>
              Your trades
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Figure({ k, v, w = "min-w-[8ch]" }: { k: string; v: string; w?: string }) {
  return (
    <div className="flex gap-1.5">
      <dt>{k}</dt>
      <dd className={cn("text-ink", w)}>{v}</dd>
    </div>
  );
}

function Letter({ c, children }: { c: string; children: string }) {
  return (
    <span aria-hidden className="num flex size-4 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: c }}>
      {children}
    </span>
  );
}
