import { NextResponse } from "next/server";
import { marketCloses } from "@/lib/lighter";

export const dynamic = "force-dynamic";

const RANGES = { "1d": ["15m", 900, 97], "1w": ["1h", 3_600, 169], "1m": ["4h", 14_400, 181] } as const;

/** `?symbol=BTC&range=1d|1w|1m`: a market's closes on Lighter */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const symbol = q.get("symbol") ?? "";
  const range = q.get("range") ?? "1d";
  if (!/^[A-Z0-9]{1,16}$/.test(symbol) || !Object.hasOwn(RANGES, range)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const [resolution, size, count] = RANGES[range as keyof typeof RANGES];
  const points = await marketCloses(symbol, resolution, size, count);
  if (points.length < 2) return NextResponse.json({ error: "no closes" }, { status: 503 });
  return NextResponse.json({ points });
}
