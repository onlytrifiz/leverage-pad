import { NextResponse } from "next/server";
import { kyberRoute, tradable } from "@/lib/kyber";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `?tokenIn&tokenOut&amountIn`: the best route now. It lives five to ten seconds. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const [tokenIn, tokenOut, amountIn] = [q.get("tokenIn") ?? "", q.get("tokenOut") ?? "", q.get("amountIn") ?? ""];
  if (!ADDRESS.test(tokenIn) || !ADDRESS.test(tokenOut) || tokenIn.toLowerCase() === tokenOut.toLowerCase() || !/^[1-9]\d{0,38}$/.test(amountIn)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    if (!(await tradable(tokenIn)) || !(await tradable(tokenOut))) return NextResponse.json({ error: "not a token of this market" }, { status: 404 });
    const { data, message } = await kyberRoute(tokenIn, tokenOut, amountIn);
    if (!data) return NextResponse.json({ error: /route not found|token not found/i.test(message) ? "no route" : message }, { status: 422 });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "quote unavailable" }, { status: 503 });
  }
}
