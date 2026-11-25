import { NextResponse } from "next/server";
import { coinChart } from "@/lib/detail";

export const dynamic = "force-dynamic";

/** 15-minute candles, for readers older than `/chart` */
export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const data = await coinChart(address, "15m").catch(() => null);
  return NextResponse.json({ candles: data?.candles ?? [] });
}
