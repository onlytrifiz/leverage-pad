import { NextResponse } from "next/server";
import { PinataSDK } from "pinata";
import { ethers } from "ethers";
import { sealSvg } from "@/lib/seal";
import { NAME_MAX, SYMBOL_MAX, ROUTER_LEVERAGES, TP_MIN_PCT, TP_MAX_PCT } from "@/lib/doppler";
import { metadataSignMessage, type EngineParams } from "@/lib/doppler";

/**
 * Pins a coin's metadata to IPFS before launch and returns the `ipfs://` token URI.
 *
 * Doppler's metadata standard (docs.doppler.lol/reference/metadata-standards): the token URI
 * must be a JSON on IPFS whose `image` field points to an IPFS CID. That is what the Doppler
 * indexer, DexScreener-style terminals and explorers read for the logo. Extra fields are
 * allowed, so the engine settings ride along under `multiply`, where the keeper reads them
 * when it adopts the coin.
 *
 * The image is the coin's seal, rendered here as a static SVG from the same geometry as the
 * animated one on the page. No user upload, nothing to moderate.
 *
 * The endpoint pins under the project's Pinata account, so it is gated: the creator signs the
 * exact payload (EIP-191, `metadataSignMessage`) with a fresh timestamp, and a small per-creator
 * limiter caps how often one wallet can pin. What gets pinned is therefore always attributable
 * to a wallet that holds its key, which is also what makes `multiply.creator` trustworthy.
 */
export const runtime = "nodejs";

const MAX = { name: NAME_MAX, symbol: SYMBOL_MAX, description: 280, link: 200 };
const SIDES = new Set(["long", "short"]);
const LEVERAGES = new Set<number>(ROUTER_LEVERAGES);
const SIGNATURE_MAX_AGE_S = 300;
const RATE = { perCreator: 6, windowMs: 10 * 60_000 };
/** best-effort limiter; per serverless instance, so a hard cap still belongs at the edge */
const recent = new Map<string, number[]>();
function overLimit(key: string) {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < RATE.windowMs);
  hits.push(now);
  recent.set(key, hits);
  return hits.length > RATE.perCreator;
}
const httpsOnly = (s: string) => (/^https:\/\/[^\s]+$/i.test(s) ? s : "");

type Body = {
  name?: string;
  symbol?: string;
  description?: string;
  creator?: string;
  engine?: { market?: string; side?: string; leverage?: number; takeProfitPct?: number; managed?: boolean };
  socials?: { x?: string; telegram?: string; website?: string };
  ts?: number;
  signature?: string;
};

const clean = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max) : "";

export async function POST(req: Request) {
  const jwt = process.env.PINATA_JWT;
  const gateway = process.env.PINATA_GATEWAY;
  if (!jwt || !gateway) {
    return NextResponse.json({ error: "Metadata pinning is not configured on this deployment." }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const name = clean(body.name, MAX.name);
  // the ticker is free-form, as typed on the form; only whitespace is dropped
  const symbol = clean(body.symbol, MAX.symbol).replace(/\s/g, "");
  const description = clean(body.description, MAX.description);
  const creator = clean(body.creator, 42);
  const e = body.engine ?? {};
  const market = clean(e.market, 16).toUpperCase();
  const side = clean(e.side, 5);
  const leverage = Number(e.leverage);
  const takeProfitPct = Number(e.takeProfitPct);
  const managed = e.managed === true;
  if (!name || !symbol) return NextResponse.json({ error: "Name and ticker are required." }, { status: 400 });
  const tpOk = Number.isInteger(takeProfitPct) && takeProfitPct >= TP_MIN_PCT && takeProfitPct <= TP_MAX_PCT;
  if (!market || !SIDES.has(side) || !tpOk || !LEVERAGES.has(leverage)) {
    return NextResponse.json({ error: "Engine settings are incomplete." }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(creator)) {
    return NextResponse.json({ error: "Creator must be an address." }, { status: 400 });
  }
  // the creator proves it holds the key: signature over the exact payload, fresh
  const ts = Number(body.ts);
  const nowS = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(nowS - ts) > SIGNATURE_MAX_AGE_S) {
    return NextResponse.json({ error: "Signature expired, try again." }, { status: 401 });
  }
  const engine: EngineParams = { market, side: side as "long" | "short", leverage, takeProfitPct, managed };
  let signer = "";
  try {
    signer = ethers.utils.verifyMessage(metadataSignMessage({ name, symbol, creator, engine, ts }), String(body.signature ?? ""));
  } catch {
    /* malformed signature: handled below */
  }
  if (signer.toLowerCase() !== creator.toLowerCase()) {
    return NextResponse.json({ error: "The metadata must be signed by the launching wallet." }, { status: 401 });
  }
  if (overLimit(creator.toLowerCase())) {
    return NextResponse.json({ error: "Too many pins from this wallet, wait a few minutes." }, { status: 429 });
  }

  const pinata = new PinataSDK({ pinataJwt: jwt, pinataGateway: gateway });
  try {
    const svg = sealSvg({ leverage, side: side as "long" | "short", takeProfitPct, symbol });
    const image = await pinata.upload.public
      .file(new File([svg], `${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "coin"}-seal.svg`, { type: "image/svg+xml" }))
      .name(`${symbol} seal`);
    const imageUri = `ipfs://${image.cid}`;

    const metadata = {
      name,
      symbol,
      description:
        description ||
        `${name} ($${symbol}): a coin whose trading fees run a ${leverage}x ${side} on ${market}. Launched on multiply.cash.`,
      image: imageUri,
      x: httpsOnly(clean(body.socials?.x, MAX.link)),
      telegram: httpsOnly(clean(body.socials?.telegram, MAX.link)),
      website: httpsOnly(clean(body.socials?.website, MAX.link)),
      multiply: { v: 2, market, side, leverage, takeProfitPct, managed, creator },
    };
    const json = await pinata.upload.public.json(metadata).name(`${symbol} metadata`);
    return NextResponse.json({
      tokenURI: `ipfs://${json.cid}`,
      imageUri,
      gatewayUrl: `https://${gateway}/ipfs/${json.cid}`,
      metadata,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "pinning failed";
    return NextResponse.json({ error: `Could not pin metadata: ${msg.slice(0, 160)}` }, { status: 502 });
  }
}
