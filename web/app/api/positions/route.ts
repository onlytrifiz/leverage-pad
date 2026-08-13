import { NextResponse } from "next/server";
import { openPositions } from "@/lib/detail";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ positions: await openPositions() });
}
