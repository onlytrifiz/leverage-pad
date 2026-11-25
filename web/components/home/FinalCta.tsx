import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LaunchIcon } from "@/components/brand/LaunchIcon";
import { EngravedArt } from "@/components/brand/EngravedArt";
import { RevealBlock } from "@/components/motion";

/**
 * The last word, and the bear's only appearance on the page: a token here
 * does not need the market to go one way. A short engine buys back on the way
 * down, a long one on the way up.
 */
export default function FinalCta() {
  return (
    <RevealBlock>
      <section className="frame-engraved hatch-brand relative overflow-hidden rounded-[18px]">
        <div className="grid grid-cols-1 items-center gap-8 px-6 py-12 sm:px-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:py-16">
          <div className="min-w-0">
            <h2 className="max-w-[16ch] text-4xl leading-[1.04] font-bold tracking-[-0.03em] sm:text-5xl">
              Bull or bear, <span className="text-brand">there&apos;s a token for it.</span>
            </h2>
            <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-ink-2">
              Go long the asset you believe in, or short the one you don&apos;t. Either way, a winning call buys your
              token back.
            </p>
            <Button size="xl" className="mt-8" nativeButton={false} render={<Link href="/launch" />}>
              <LaunchIcon />
              Launch a token
            </Button>
          </div>
          <div className="mx-auto w-full max-w-[460px] text-ink/85 lg:mr-0">
            <EngravedArt name="bear" />
          </div>
        </div>
      </section>
    </RevealBlock>
  );
}
