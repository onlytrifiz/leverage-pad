"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Container } from "@/components/ui/container";
import { Button } from "@/components/ui/button";

/**
 * Pages read the chain and Lighter on every request, so a failure here usually
 * means an upstream is unreachable rather than a bug — the copy says so, and
 * retry is the first thing offered.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Container className="flex min-h-[calc(100dvh-var(--nav-h)-160px)] flex-col items-center justify-center py-16 text-center">
      <h1 className="text-4xl font-bold">This page could not be loaded</h1>
      <p className="mt-3 max-w-[440px] text-base leading-relaxed text-ink-2">
        The figures come from the chain and from Lighter. If either is slow or rate-limiting
        right now, a retry in a moment usually works.
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Button size="xl" onClick={reset}>
          Try again
        </Button>
        <Button size="xl" variant="outline" nativeButton={false} render={<Link href="/" />}>
          Back to the market
        </Button>
      </div>
      {error.digest && <p className="num mt-6 text-xs text-ink-3">Ref {error.digest}</p>}
    </Container>
  );
}
