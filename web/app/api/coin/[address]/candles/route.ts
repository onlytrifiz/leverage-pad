import { NextResponse } from "next/server";
import { coinCandles } from "@/lib/detail";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  return NextResponse.json({ candles: await coinCandles(address) });
}
