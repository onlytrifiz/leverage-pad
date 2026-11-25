import { NextResponse } from "next/server";
import { kyberBuild, tradable, type KyberRoute } from "@/lib/kyber";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `{ routeSummary, sender, slippageBps }` → the transaction. The tokens always go to the sender. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { routeSummary?: KyberRoute["routeSummary"]; sender?: string; slippageBps?: number } | null;
  const rs = b?.routeSummary;
  const slippage = Number(b?.slippageBps);
  if (!rs || typeof rs !== "object" || !ADDRESS.test(String(rs.tokenIn)) || !ADDRESS.test(String(rs.tokenOut)) || !ADDRESS.test(String(b?.sender)) || !(slippage >= 1 && slippage <= 2_000)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    if (!(await tradable(rs.tokenIn)) || !(await tradable(rs.tokenOut))) return NextResponse.json({ error: "not a token of this market" }, { status: 404 });
    const { data, message } = await kyberBuild(rs, b!.sender!, Math.round(slippage));
    if (!data) return NextResponse.json({ error: message }, { status: 422 });
    return NextResponse.json({ to: data.routerAddress, data: data.data, value: data.transactionValue ?? "0", amountOut: data.amountOut });
  } catch {
    return NextResponse.json({ error: "build unavailable" }, { status: 503 });
  }
}
