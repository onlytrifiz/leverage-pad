import { NextResponse } from "next/server";
import { coinFeedItems } from "@/lib/detail";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  return NextResponse.json({ items: await coinFeedItems(address) });
}
