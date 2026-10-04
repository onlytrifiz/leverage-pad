import Link from "next/link";
import Image from "next/image";
import { CHAIN, explorerAddr } from "@/lib/clientConfig";
import { IntroLink } from "@/components/intro/IntroButton";
import { Reveal, RevealItem } from "@/components/motion";

/**
 * Brand, link columns and the protocol's moving parts. Provenance belongs where somebody
 * looking for it goes to look: the launch router's address lives down here, next to the
 * docs, not in a headline.
 */
const COLUMNS: { heading: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Market", href: "/market" },
      { label: "Launch a coin", href: "/launch" },
      { label: "Stats", href: "/stats" },
    ],
  },
  {
    heading: "Learn",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "The engine", href: "/docs/engine" },
      { label: "Whitepaper", href: "/whitepaper.pdf", external: true },
    ],
  },
];

export default function Footer({ router }: { router?: string }) {
  const short = router ? `${router.slice(0, 6)}…${router.slice(-4)}` : "";
  return (
    <footer className="relative mt-16 overflow-hidden border-t border-border bg-panel">
      <div className="mx-auto w-full max-w-[1320px] px-4 pt-14 sm:px-5">
        <Reveal className="grid grid-cols-2 gap-x-8 gap-y-10 text-sm md:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]">
          <RevealItem className="col-span-2 md:col-span-1">
            <Link href="/" className="inline-flex items-center gap-2">
              <Image src="/logo-transparent.png" alt="" width={24} height={24} />
              <span className="font-display text-lg font-bold tracking-tight text-ink">
                multiply<span className="text-brand">.cash</span>
              </span>
            </Link>
            <p className="mt-3 max-w-[34ch] leading-relaxed text-ink-3">
              Coins whose trading fees run a leveraged trade. Profits buy the coin back and burn it.
            </p>
            <IntroLink className="mt-4 text-sm font-medium text-brand underline-offset-4 hover:underline" />
          </RevealItem>

          {COLUMNS.map((col) => (
            <RevealItem key={col.heading}>
              <div className="font-semibold text-ink">{col.heading}</div>
              <ul className="mt-3 space-y-2.5 text-ink-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.external ? (
                      <a href={l.href} target="_blank" rel="noreferrer" className="transition-colors hover:text-brand">
                        {l.label}
                      </a>
                    ) : (
                      <Link href={l.href} className="transition-colors hover:text-brand">
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </RevealItem>
          ))}

          <RevealItem>
            <div className="font-semibold text-ink">Protocol</div>
            <ul className="mt-3 space-y-2.5 text-ink-2">
              {router && (
                <li>
                  <a href={explorerAddr(router)} target="_blank" rel="noreferrer" className="transition-colors hover:text-brand">
                    Router <span className="num text-ink-3">{short}</span>
                  </a>
                </li>
              )}
              <li>Uniswap v4 · Doppler</li>
              <li>Lighter perps</li>
              <li>{CHAIN.name}</li>
            </ul>
          </RevealItem>
        </Reveal>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line py-5 text-xs text-ink-3">
          <span>© {new Date().getFullYear()} multiply.cash</span>
          <span>Liquidity locked forever · fees → perp → buyback &amp; burn</span>
        </div>
      </div>

    </footer>
  );
}
