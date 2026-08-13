import Link from "next/link";
import { WalletButton } from "./wallet";

export default function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-void/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center gap-6 px-4">
        <Link href="/" className="flex items-baseline gap-1.5">
          <span className="green-glow text-[16px] font-bold leading-none text-accent-bright">×</span>
          <span className="text-[15px] font-bold tracking-tight text-ink">
            multiply<span className="text-accent-bright">.cash</span>
          </span>
        </Link>
        <nav className="flex items-center gap-5 text-[11px] uppercase tracking-[0.14em] text-ink-2">
          <Link href="/" className="transition-colors hover:text-ink">Market</Link>
          <Link href="/launch" className="transition-colors hover:text-ink">Launch</Link>
          <Link href="/stats" className="transition-colors hover:text-ink">Stats</Link>
          <Link href="/docs" className="transition-colors hover:text-ink">Docs</Link>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <span className="lbl hidden items-center gap-1.5 md:flex">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-bright" />
            Robinhood Chain · 4663
          </span>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
