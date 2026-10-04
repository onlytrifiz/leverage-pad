"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { motion } from "motion/react";
import { Container } from "@/components/ui/container";
import { WalletButton } from "@/components/wallet";

const LINKS = [
  { href: "/market", label: "Market" },
  { href: "/launch", label: "Launch" },
  { href: "/stats", label: "Stats" },
  { href: "/docs", label: "Docs" },
];

/**
 * The header owns `--nav-h`: its height is a token, not a number retyped in the
 * ticker's `top-[64px]` and the rails' `top:118px`. Below `sm` the links wrap to
 * a second row, which is why the token changes at that breakpoint — the ticker
 * used to stick at the desktop height and sit on top of them.
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
        {/*
          Narrow screens: the links get their own row and scroll rather than
          compress, so a fifth entry can never widen the document.
        */}
        <nav
          aria-label="Main"
          className="-mx-4 flex items-center gap-6 overflow-x-auto px-4 pb-3 sm:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {navLinks("mobile")}
        </nav>
      </Container>
    </header>
  );
}
