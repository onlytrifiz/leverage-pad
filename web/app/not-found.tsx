import Link from "next/link";
import NotFoundMark from "@/components/NotFoundMark";
import { Container } from "@/components/ui/container";
import { Button } from "@/components/ui/button";
import { Sparkles } from "@/components/animate-ui/icons/sparkles";

export const metadata = { title: "Page not found" };

/**
 * The 404 gets the same frame as the rest of the site. It is the screen most
 * likely to be somebody's first impression — you arrive at it from a broken
 * link or a mistyped address — so it explains what tends to go wrong in this
 * particular domain, and offers both ways out: back to the market, and the
 * product's primary action.
 */
export default function NotFound() {
  return (
    <Container className="flex min-h-[calc(100dvh-var(--nav-h)-160px)] flex-col items-center justify-center py-16 text-center">
      <NotFoundMark />
      <h1 className="mt-6 text-4xl font-bold">Nothing at this address</h1>
      <p className="mt-3 max-w-[440px] text-base leading-relaxed text-ink-2">
        A coin page needs the full contract address, and a token that has not been launched
        here will not have one. If you pasted an address, check it did not lose a character
        on the way.
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Button size="xl" nativeButton={false} render={<Link href="/" />}>
          Back to the market
        </Button>
        <Button size="xl" variant="outline" nativeButton={false} render={<Link href="/launch" />}>
          <Sparkles aria-hidden size={15} animateOnHover />
          Launch a coin
        </Button>
      </div>
    </Container>
  );
}
