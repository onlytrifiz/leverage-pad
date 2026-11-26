import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { LogoMark } from "@/components/brand/LogoMark";
import { CHAIN, EXPLORER, PLATFORM_TOKEN, explorerAddr } from "@/lib/clientConfig";
import { IntroLink } from "@/components/intro/IntroButton";
import { Reveal, RevealItem } from "@/components/motion";

/**
 * The claim, the places to go, and what somebody checks before trusting it: the contracts, the
 * risks and who the pieces belong to. Every line of it leads somewhere.
 */
type FooterLink = { label: string; href: string };

const COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Market", href: "/market" },
      { label: "Launch a token", href: "/launch" },
      { label: "$MULTIPLY", href: `/token/${PLATFORM_TOKEN}` },
      { label: "Buyback & burn", href: "/burn" },
      { label: "Stats", href: "/stats" },
    ],
  },
  {
    heading: "Learn",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "The engine", href: "/docs/engine" },
      { label: "Take-profits", href: "/docs/tranches" },
      { label: "Who earns what", href: "/docs/economics" },
      { label: "Whitepaper", href: "/whitepaper.pdf" },
    ],
  },
];

const BUILT_ON: FooterLink[] = [
  { label: "Lighter", href: "https://lighter.xyz" },
  { label: "Uniswap", href: "https://uniswap.org" },
  { label: "Doppler", href: "https://doppler.lol" },
  { label: CHAIN.name, href: EXPLORER },
];

const linkClass = "transition-colors hover:text-brand";

export default function Footer({ router }: { router?: string }) {
  const trust: FooterLink[] = [
    { label: "Contract guarantees", href: "/docs/contracts" },
    { label: "Addresses", href: "/docs/verify" },
    { label: "Risks", href: "/docs/risks" },
  ];
  return (
    <footer className="relative mt-16 overflow-hidden border-t border-border bg-panel">
      <div className="mx-auto w-full max-w-[1320px] px-4 pt-14 sm:px-5 sm:pt-16">
        <Reveal className="grid grid-cols-2 gap-x-8 gap-y-11 text-sm md:grid-cols-[minmax(0,1.7fr)_repeat(3,minmax(0,1fr))]">
          <RevealItem className="col-span-2 min-w-0 md:col-span-1">
            <Link href="/" className="inline-flex items-center gap-2">
              <LogoMark />
              <span className="font-display text-lg font-bold tracking-tight text-ink">
                multiply<span className="text-brand">.cash</span>
              </span>
            </Link>
            <p className="mt-5 font-display text-2xl leading-[1.12] font-bold tracking-[-0.02em] text-ink">
              Bet on any market.
              <br />
              In either direction.
            </p>
            <p className="mt-3 max-w-[38ch] leading-relaxed text-ink-3">
              Every token here holds a perp. Trading fees load it, and when it wins it buys the token and burns it.
            </p>
            <IntroLink className="mt-4 text-sm font-semibold text-brand underline-offset-4 hover:underline" />
          </RevealItem>

          {COLUMNS.map((col) => (
            <Column key={col.heading} heading={col.heading}>
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.href.endsWith(".pdf") ? (
                    <External href={l.href}>{l.label}</External>
                  ) : (
                    <Link href={l.href} className={linkClass}>
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </Column>
          ))}

          <Column heading="Under the hood">
            {trust.map((l) => (
              <li key={l.label}>
                <Link href={l.href} className={linkClass}>
                  {l.label}
                </Link>
              </li>
            ))}
            {router && (
              <li>
                <External href={explorerAddr(router)}>Launch router</External>
              </li>
            )}
          </Column>
        </Reveal>

        <div className="mt-12 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-5 text-sm text-ink-2">
          <span className="text-ink-3">Built on</span>
          {BUILT_ON.map((l) => (
            <External key={l.label} href={l.href}>
              {l.label}
            </External>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-start justify-between gap-x-10 gap-y-3 pb-7 text-xs leading-relaxed text-ink-3">
          <p className="max-w-[72ch]">
            Positions use leverage and can be liquidated: the fees in them are lost, the pool and every balance stay as they are.
            Tokens can go to zero. Only use what you can afford to lose.
          </p>
          <span className="shrink-0">© {new Date().getFullYear()} multiply.cash</span>
        </div>
      </div>
    </footer>
  );
}

function Column({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <RevealItem className="min-w-0">
      <div className="font-semibold text-ink">{heading}</div>
      <ul className="mt-3.5 space-y-2.5 text-ink-2">{children}</ul>
    </RevealItem>
  );
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-0.5 ${linkClass}`}>
      {children}
      <ArrowUpRight size={13} aria-hidden className="text-ink-3" />
    </a>
  );
}
