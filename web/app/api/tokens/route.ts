import { NextResponse } from "next/server";
import { allTokenLogos } from "@/lib/lighter";

/**
 * Logo ed estensione di ogni token Lighter, per le icone.
 *
 * Non e' `force-dynamic` come le altre rotte: l'anagrafica cambia quando nasce
 * un mercato, e ogni richiesta risparmiata qui e' un round trip in meno su una
 * pagina che ne fa gia' parecchi.
 */
export const revalidate = 3600;

export async function GET() {
  return NextResponse.json(
    { logos: await allTokenLogos() },
    { headers: { "cache-control": "public, max-age=600, stale-while-revalidate=3600" } }
  );
}
