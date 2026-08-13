import { NextResponse } from "next/server";
import { allMarkets } from "@/lib/lighter";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ markets: await allMarkets() });
}
