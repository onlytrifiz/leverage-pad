import type { EngineSettings } from "./types";

/** what a change of engine changes, in words: "NVDA long → BTC short, 10x → 5x" */
export function engineDiff(from: EngineSettings, to: EngineSettings): string {
  const parts: string[] = [];
  if (from.market !== to.market) parts.push(`${from.market} ${from.side} → ${to.market} ${to.side}`);
  else if (from.side !== to.side) parts.push(`${from.market} ${from.side} → ${to.side}`);
  if (from.leverage !== to.leverage) parts.push(`${from.leverage}x → ${to.leverage}x`);
  if (from.takeProfitPct !== to.takeProfitPct) parts.push(`take-profit +${from.takeProfitPct}% → +${to.takeProfitPct}%`);
  return parts.join(", ") || "no change";
}
