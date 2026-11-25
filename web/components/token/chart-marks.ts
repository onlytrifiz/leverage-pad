import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartMark } from "@/lib/types";

/**
 * What the chart draws over its series: the engraved hatch under the line, the engine's buybacks,
 * and the dated lines that run through both panes.
 */

export type Buyback = { time: UTCTimestamp; above: number; usd: number; tokens: number };
export type DatedLine = { time: UTCTimestamp; label: string };

/** index of the last candle at or before `t`; -1 before the first */
function indexAt(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** buybacks by candle; what is older than the series is left out */
export function placeBuybacks(candles: Candle[], scale: number, line: boolean, marks: ChartMark[]): Buyback[] {
  const out = new Map<number, Buyback>();
  for (const m of marks) {
    const i = indexAt(candles, m.ts);
    if (i < 0) continue;
    const c = candles[i];
    const b = out.get(c.time) ?? { time: c.time as UTCTimestamp, above: (line ? c.close : c.high) * scale, usd: 0, tokens: 0 };
    b.usd += m.usd;
    b.tokens += m.tokens;
    out.set(c.time, b);
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

/** dated moments on the candle they fell in; several on one candle share a line */
export function placeLines(candles: Candle[], lines: { ts: number; label: string }[]): DatedLine[] {
  const out = new Map<number, string>();
  for (const l of lines) {
    const i = indexAt(candles, l.ts);
    const c = i >= 0 ? candles[i] : undefined;
    if (c) out.set(c.time, out.has(c.time) ? `${out.get(c.time)}, ${l.label}` : l.label);
  }
  return [...out.entries()].map(([time, label]) => ({ time: time as UTCTimestamp, label })).sort((a, b) => a.time - b.time);
}

/** the logo's rising arrow, 16 units tall around (0, 0): the engine buying its token back */
export const ARROW_PATH = "M3.5 -8L7.2 -0.6H4.4L1.4 8H-5.8L0.4 -0.6H-1.2Z";

/** closer than this two buybacks would overlap: the first stands for both */
const MIN_GAP = 12;

abstract class Layer implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  private redraw: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];
  constructor(z: PrimitivePaneViewZOrder) {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) =>
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          if (this.chart && this.series) this.paint(context, mediaSize.width, mediaSize.height, this.chart, this.series);
        }),
    };
    this.views = [{ zOrder: () => z, renderer: () => renderer }];
  }
  protected abstract paint(ctx: CanvasRenderingContext2D, w: number, h: number, chart: IChartApi, series: ISeriesApi<SeriesType>): void;
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = chart as IChartApi;
    this.series = series;
    this.redraw = requestUpdate;
  }
  detached() {
    this.chart = null;
    this.series = null;
    this.redraw = null;
  }
  paneViews() {
    return this.views;
  }
  protected update() {
    this.redraw?.();
  }
}

/** the line's fill, engraved like the notes: diagonal strokes clipped to the area under it */
export class HatchLayer extends Layer {
  private points: { time: UTCTimestamp; value: number }[] = [];
  constructor(private readonly stroke: string) {
    super("bottom");
  }
  set(points: { time: UTCTimestamp; value: number }[]) {
    this.points = points;
    this.update();
  }
  protected paint(ctx: CanvasRenderingContext2D, w: number, h: number, chart: IChartApi, series: ISeriesApi<SeriesType>) {
    const scale = chart.timeScale();
    const at = this.points
      .map((p) => ({ x: scale.timeToCoordinate(p.time), y: series.priceToCoordinate(p.value) }))
      .filter((p): p is { x: NonNullable<typeof p.x>; y: NonNullable<typeof p.y> } => p.x !== null && p.y !== null);
    if (at.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(at[0].x, h);
    for (const p of at) ctx.lineTo(p.x, p.y);
    ctx.lineTo(at[at.length - 1].x, h);
    ctx.closePath();
    ctx.clip();
    const x0 = Math.max(0, at[0].x);
    const x1 = Math.min(w, at[at.length - 1].x);
    // fading to the floor, as an engraver lets the strokes thin out
    const fade = ctx.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, this.stroke);
    fade.addColorStop(1, "rgba(12,52,32,0.04)");
    ctx.strokeStyle = fade;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0 - h - ((x0 - h) % 6); x < x1; x += 6) {
      ctx.moveTo(x, h);
      ctx.lineTo(x + h, 0);
    }
    ctx.stroke();
    ctx.restore();
  }
}

export type MarkPalette = { ink: string; mint: string; axis: string; paper: string; font: string };

/** buybacks and dated lines; on the asset's pane the same lines without their labels */
export class MarksLayer extends Layer {
  private buybacks: Buyback[] = [];
  private lines: DatedLine[] = [];
  constructor(
    private readonly p: MarkPalette,
    private readonly labelled: boolean
  ) {
    super("top");
  }
  set(buybacks: Buyback[], lines: DatedLine[]) {
    this.buybacks = buybacks;
    this.lines = lines;
    this.update();
  }
  protected paint(ctx: CanvasRenderingContext2D, w: number, h: number, chart: IChartApi, series: ISeriesApi<SeriesType>) {
    const scale = chart.timeScale();
    const { p } = this;
    ctx.textBaseline = "middle";
    ctx.font = `10px ${p.font}`;
    const labels: { x: number; row: number; text: string }[] = [];
    let row = 0;
    let lastX = -Infinity;
    for (const l of this.lines) {
      const x = scale.timeToCoordinate(l.time);
      if (x === null || x < 0 || x > w) continue;
      row = x - lastX < 110 ? row + 1 : 0; // neighbours step down instead of printing over each other
      lastX = x;
      ctx.strokeStyle = p.axis;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      labels.push({ x, row, text: l.label });
    }
    if (!this.labelled) return;
    // after every line, so none of them runs through a label
    for (const { x, row: r, text } of labels) {
      const tw = ctx.measureText(text).width;
      const left = x + 10 + tw < w;
      ctx.textAlign = left ? "left" : "right";
      ctx.fillStyle = p.paper;
      ctx.globalAlpha = 0.92;
      ctx.fillRect(left ? x + 3 : x - tw - 7, 5 + r * 15, tw + 4, 14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.axis;
      ctx.fillText(text, x + (left ? 5 : -5), 12 + r * 15);
    }

    const arrow = new Path2D(ARROW_PATH);
    let last = -Infinity;
    for (const b of this.buybacks) {
      const x = scale.timeToCoordinate(b.time);
      const y0 = series.priceToCoordinate(b.above);
      if (x === null || y0 === null || x - last < MIN_GAP) continue;
      last = x;
      const y = y0 - 15;
      ctx.fillStyle = p.paper;
      ctx.beginPath();
      ctx.arc(x, y, 10.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.ink;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(0.62, 0.62);
      ctx.fillStyle = p.mint;
      ctx.fill(arrow);
      ctx.restore();
    }
  }
}
