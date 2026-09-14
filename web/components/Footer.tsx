import Link from "next/link";
import { Container } from "@/components/ui/container";
import { CHAIN, explorerAddr } from "@/lib/clientConfig";

/**
 * Provenance belongs where somebody looking for it goes to look: the launch
 * router's address lives down here, next to the docs link, not in the headline.
 */
export default function Footer({ router }: { router?: string }) {
  return (
    <footer className="mt-12 border-t border-border">
      <Container width="wide" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-6 text-xs text-ink-3">
        <span className="min-w-0">
          multiply.cash · liquidity locked forever · fees → perp → buyback &amp; burn
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/docs" className="transition-colors hover:text-ink">
            Docs
          </Link>
          {router && (
            <a
              href={explorerAddr(router)}
              target="_blank"
              rel="noreferrer"
              className="num transition-colors hover:text-ink"
            >
              Router {router.slice(0, 6)}…{router.slice(-4)}
            </a>
          )}
          <span>Uniswap v4 · Doppler · Lighter · {CHAIN.name}</span>
        </span>
      </Container>
    </footer>
  );
}
