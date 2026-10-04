import { NextResponse } from "next/server";
import { memo } from "@/lib/memo";
import { coinCandles } from "@/lib/detail";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  return NextResponse.json({ candles: await memo(`candles:${address.toLowerCase()}`, 20_000, () => coinCandles(address)) });
}
