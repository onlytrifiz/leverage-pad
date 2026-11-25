import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartMark } from "@/lib/types";

/** what happened on one candle, and the chart values its glyphs stand off from */
export type MarkStack = {
  time: UTCTimestamp;
  above: number;
  below: number;
  buyback?: { usd: number; tokens: number };
  bought?: number;
  sold?: number;
};

export type DatedLine = { time: UTCTimestamp; label: string };

/** index of the last candle at or before `t`; -1 before the first. Quiet buckets have no candle. */
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

/** one stack per candle with something on it; what is older than the series is left out */
export function stackMarks(candles: Candle[], scale: number, line: boolean, marks: ChartMark[]): MarkStack[] {
  const out = new Map<number, MarkStack>();
  for (const m of marks) {
    const i = indexAt(candles, m.ts);
    if (i < 0) continue;
    const c = candles[i];
    const s = out.get(c.time) ?? {
      time: c.time as UTCTimestamp,
      above: (line ? c.close : c.high) * scale,
      below: (line ? c.close : c.low) * scale,
    };
    if (m.kind === "buyback") s.buyback = { usd: (s.buyback?.usd ?? 0) + m.usd, tokens: (s.buyback?.tokens ?? 0) + m.tokens };
    else s[m.kind] = (s[m.kind] ?? 0) + m.usd;
    out.set(c.time, s);
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

/** dated moments on the candle they fell in; several on one candle share a line */
export function placeLines(candles: Candle[], lines: { ts: number; label: string }[]): DatedLine[] {
  const out = new Map<number, string>();
  for (const l of lines) {
    const i = indexAt(candles, l.ts);
    // the launch is the first candle's own moment even when its bucket opens a second late
    const c = i >= 0 ? candles[i] : l.label === "Launch" ? candles[0] : undefined;
    if (c) out.set(c.time, out.has(c.time) ? `${out.get(c.time)}, ${l.label}` : l.label);
  }
  return [...out.entries()].map(([time, label]) => ({ time: time as UTCTimestamp, label })).sort((a, b) => a.time - b.time);
}

/** the logo's rising arrow, 16 units tall around (0, 0): the engine buying its token back */
export const ARROW_PATH = "M3.5 -8L7.2 -0.6H4.4L1.4 8H-5.8L0.4 -0.6H-1.2Z";

const STEP = 20;
/** closer than this, two glyphs of a kind would overlap: the first stands for both */
const MIN_GAP = 10;

export type MarkPalette = { up: string; down: string; ink: string; axis: string; paper: string; font: string };

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: ChartMarksLayer) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    const { chart, series, stacks, lines, palette: p } = this.source;
    if (!chart || !series) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const scale = chart.timeScale();
      ctx.textBaseline = "middle";

      ctx.font = `10px ${p.font}`;
      let row = 0;
      let lastX = -Infinity;
      const labels: { x: number; row: number; text: string }[] = [];
      for (const l of lines) {
        const x = scale.timeToCoordinate(l.time);
        if (x === null || x < 0 || x > mediaSize.width) continue;
        // neighbours step down instead of printing over each other
        row = x - lastX < 90 ? row + 1 : 0;
        lastX = x;
        ctx.strokeStyle = p.axis;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mediaSize.height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        labels.push({ x, row, text: l.label });
      }
      // after every line, so none of them runs through a label
      for (const { x, row: r, text } of labels) {
        const w = ctx.measureText(text).width;
        const fits = x + 8 + w < mediaSize.width;
        ctx.textAlign = fits ? "left" : "right";
        ctx.fillStyle = p.paper;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(fits ? x + 3 : x - w - 7, 4 + r * 14, w + 4, 14);
        ctx.globalAlpha = 1;
        ctx.fillStyle = p.axis;
        ctx.fillText(text, x + (fits ? 5 : -5), 11 + r * 14);
      }

      const arrow = new Path2D(ARROW_PATH);
      const disc = (x: number, y: number, fill: string, r = 8) => {
        // a ring of paper keeps a glyph readable over a candle
        ctx.fillStyle = p.paper;
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      };
      ctx.textAlign = "center";
      ctx.font = `bold 9px ${p.font}`;
      const last = { buyback: -Infinity, bought: -Infinity, sold: -Infinity };
      for (const s of stacks) {
        const x = scale.timeToCoordinate(s.time);
        if (x === null) continue;
        const top = series.priceToCoordinate(s.above);
        const bottom = series.priceToCoordinate(s.below);
        if (top === null || bottom === null) continue;
        let y = top - 14;
        if (s.sold && x - last.sold >= MIN_GAP) {
          disc(x, y, p.down);
          ctx.fillStyle = p.paper;
          ctx.fillText("S", x, y + 0.5);
          last.sold = x;
          y -= STEP;
        }
        if (s.buyback && x - last.buyback >= MIN_GAP) {
          disc(x, y, p.ink, 9);
          ctx.save();
          ctx.translate(x, y);
          ctx.scale(0.62, 0.62);
          ctx.fillStyle = "#8ce8b0";
          ctx.fill(arrow);
          ctx.restore();
          last.buyback = x;
        }
        if (s.bought && x - last.bought >= MIN_GAP) {
          disc(x, bottom + 14, p.up);
          ctx.fillStyle = p.paper;
          ctx.fillText("B", x, bottom + 14.5);
          last.bought = x;
        }
      }
    });
  }
}

class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(source: ChartMarksLayer) {
    this.r = new Renderer(source);
  }
  zOrder() {
    return "top" as const;
  }
  renderer() {
    return this.r;
  }
}

/** the glyphs and the dated lines, drawn with the series so they follow every zoom and scroll */
export class ChartMarksLayer implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  stacks: MarkStack[] = [];
  lines: DatedLine[] = [];
  private redraw: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(readonly palette: MarkPalette) {
    this.views = [new View(this)];
  }
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
  set(stacks: MarkStack[], lines: DatedLine[]) {
    this.stacks = stacks;
    this.lines = lines;
    this.redraw?.();
  }
}
