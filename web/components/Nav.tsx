"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { motion } from "motion/react";
import { BookOpen, ChartColumn, LayoutGrid, Sparkles, type LucideIcon } from "lucide-react";
import { Container } from "@/components/ui/container";
import { WalletButton } from "@/components/wallet";

const LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/market", label: "Market", icon: LayoutGrid },
  { href: "/launch", label: "Launch", icon: Sparkles },
  { href: "/stats", label: "Stats", icon: ChartColumn },
  { href: "/docs", label: "Docs", icon: BookOpen },
];

/**
 * The header owns `--nav-h`: its height is a token, not a number retyped in the
 * ticker's `top-[64px]` and the rails' `top:118px`. It is one row everywhere:
 * below `sm` the links move to a bottom tab bar, where a thumb reaches them.
 */
export default function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname.startsWith(href);

  /*
   * The active item carries a shared `layoutId`, so the marker travels between
   * links instead of blinking out on one and in on another — the movement is
   * what tells you where you came from.
   */
  const navLinks = (scope: string) =>
    LINKS.map((l) => (
      <Link
        key={l.href}
        href={l.href}
        aria-current={isActive(l.href) ? "page" : undefined}
        className={cn(
          "relative shrink-0 py-1 text-md transition-colors hover:text-ink",
          isActive(l.href) ? "font-semibold text-ink" : "text-ink-2"
        )}
      >
        {l.label}
        {isActive(l.href) && (
          <motion.span
            layoutId={`nav-active-${scope}`}
            className="absolute -bottom-0.5 left-0 h-0.5 w-full rounded-full bg-brand"
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          />
        )}
      </Link>
    ));

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-void/85 backdrop-blur">
      <Container width="wide">
        <div className="flex h-16 min-w-0 items-center gap-6">
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <Image src="/logo-transparent.png" alt="" width={26} height={26} priority />
            <span className="font-display text-lg font-bold tracking-tight text-ink">
              multiply<span className="text-brand">.cash</span>
            </span>
          </Link>
          <nav aria-label="Main" className="hidden min-w-0 items-center gap-5 sm:flex">
            {navLinks("desktop")}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <WalletButton />
          </div>
        </div>
      </Container>
    </header>
  );
}

/**
 * The phone's navigation: four tabs fixed to the bottom edge, above the home
 * indicator. The body reserves the same height (see the layout), so the footer
 * and the last row of any page never sit under it. Overlays (the intro, sheets,
 * the launch wash) stack above it.
 */
export function BottomBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-void/90 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
    >
      <ul className="grid h-16 grid-cols-4">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <li key={href} className="min-w-0">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-full flex-col items-center justify-center gap-1 text-2xs font-medium transition-colors",
                  active ? "text-brand" : "text-ink-3 active:text-ink"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="bottom-bar-active"
                    aria-hidden
                    className="absolute inset-x-2.5 inset-y-1.5 rounded-xl bg-brand-soft"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <Icon size={20} strokeWidth={active ? 2.25 : 1.75} aria-hidden className="relative" />
                <span className="relative">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
