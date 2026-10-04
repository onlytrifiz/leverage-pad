"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { motion } from "motion/react";
import { BookOpenText, ChartBar, RocketLaunch, Storefront, type Icon } from "@phosphor-icons/react";
import { WalletButton } from "@/components/wallet";

const LINKS: { href: string; label: string; icon: Icon }[] = [
  { href: "/market", label: "Market", icon: Storefront },
  { href: "/launch", label: "Launch", icon: RocketLaunch },
  { href: "/stats", label: "Stats", icon: ChartBar },
  { href: "/docs", label: "Docs", icon: BookOpenText },
];

/**
 * A floating header: a glass pill that stays on screen while the page scrolls behind it.
 *
 * The wrapper is in the flow and transparent, so the pill floats over the page with a margin
 * around it; its height (margins included) is the `--nav-h` token the sticky pieces below read.
 * On a phone the links leave for the bottom bar and the pill keeps the logo and the wallet.
 */
export default function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <header className="pointer-events-none sticky top-0 z-30 px-3 pt-3 pb-2 sm:px-5">
      <div className="pointer-events-auto mx-auto flex h-14 w-full max-w-[1320px] min-w-0 items-center gap-6 rounded-2xl border border-border bg-card/92 pr-2 pl-4 shadow-[0_10px_32px_-16px_rgba(12,52,32,0.35)] backdrop-blur-xl">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Image src="/logo-transparent.png" alt="" width={26} height={26} priority />
          <span className="font-display text-lg font-bold tracking-tight text-ink">
            multiply<span className="text-brand">.cash</span>
          </span>
        </Link>

        <nav aria-label="Main" className="hidden min-w-0 items-center gap-1 sm:flex">
          {LINKS.map((l) => {
            const active = isActive(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative rounded-xl px-3 py-1.5 text-md transition-colors",
                  active ? "font-semibold text-brand" : "text-ink-2 hover:text-ink"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="nav-active"
                    aria-hidden
                    className="absolute inset-0 rounded-xl bg-brand-soft"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative">{l.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

/**
 * The phone's navigation: a floating pill near the bottom edge, above the home indicator,
 * with a highlight that slides to the active tab. The body reserves its height (see the
 * layout), so the footer and the last row of any page never sit under it. Overlays (the
 * intro, sheets, the launch wash) stack above it.
 */
export function BottomBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] z-40 rounded-full border border-border bg-card/92 p-1.5 shadow-[0_12px_36px_-14px_rgba(12,52,32,0.45)] backdrop-blur-xl sm:hidden"
    >
      <ul className="grid grid-cols-4">
        {LINKS.map(({ href, label, icon: Glyph }) => {
          const active = pathname.startsWith(href);
          return (
            <li key={href} className="min-w-0">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-full text-[10px] font-semibold transition-colors",
                  active ? "text-brand" : "text-ink-3 active:text-ink"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="bottom-bar-active"
                    aria-hidden
                    className="absolute inset-0 rounded-full bg-brand-soft"
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                <Glyph size={22} weight={active ? "fill" : "duotone"} aria-hidden className="relative" />
                <span className="relative">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
