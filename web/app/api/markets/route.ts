import { NextResponse } from "next/server";
import { allMarkets } from "@/lib/lighter";

export const dynamic = "force-dynamic";

export async function GET() {
  const markets = await allMarkets();
  // an empty list is a failed read, never the truth: say so, and the page keeps the one it has
  if (!markets.length) return NextResponse.json({ error: "markets unavailable" }, { status: 503 });
  return NextResponse.json({ markets });
}
