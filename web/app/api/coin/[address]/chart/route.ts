import { NextResponse } from "next/server";
import { coinChart } from "@/lib/detail";
import { RESOLUTIONS } from "@/lib/resolutions";
import type { Resolution } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?res=5m&trader=0x…`: candles, marks and, for a wallet, its own trades */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const q = new URL(req.url).searchParams;
  const res = q.get("res") ?? "5m";
  const trader = q.get("trader") ?? undefined;
  if (!Object.hasOwn(RESOLUTIONS, res) || !/^0x[0-9a-fA-F]{40}$/.test(address) || (trader && !/^0x[0-9a-fA-F]{40}$/.test(trader))) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const data = await coinChart(address, res as Resolution, trader);
    if (!data) return NextResponse.json({ error: "token not found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (e) {
    // an error, not an empty chart: the page keeps what it has, or shows DexScreener
    console.error(`[chart] ${address}: ${(e as Error).message?.slice(0, 160)}`);
    return NextResponse.json({ error: "chart unavailable" }, { status: 503 });
  }
}
