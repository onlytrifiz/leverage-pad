import { NextResponse } from "next/server";
import { coinDetail } from "@/lib/detail";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  const detail = await coinDetail(address);
  if (!detail) return NextResponse.json({ error: "coin not found" }, { status: 404 });
  return NextResponse.json(detail);
}
