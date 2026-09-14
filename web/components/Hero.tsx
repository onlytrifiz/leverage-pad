import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Guilloche } from "@/components/brand/Guilloche";
import { AnimatedNumber, RevealBlock } from "@/components/motion";
import { Sparkles } from "@/components/animate-ui/icons/sparkles";

/**
 * The landing moment, set as an engraved instrument.
 *
 * It used to live inside the middle column of the three-column market view, so
 * the first thing anyone saw was a 780px white box between two sidebars. It is
 * full width now: the market grid starts below it.
 *
 * The rosette on the right is a real reading of the protocol, not an ornament -
 * see components/brand/Guilloche.tsx for what each parameter is bound to.
 */
export default function Hero({
  coins,
  liveEngines,
  totalBurned,
}: {
  coins: number;
  liveEngines: number;
  totalBurned: number;
}) {
  return (
    <Container width="wide" className="pt-6">
      <RevealBlock>
        <section className="frame-engraved hatch relative overflow-hidden rounded-[18px]">
          <div className="grid grid-cols-1 items-center gap-6 px-6 py-9 sm:px-10 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] lg:gap-8 lg:py-11">
            <div className="min-w-0">
              <h1 className="max-w-[14ch] text-4xl font-bold leading-[1.04] sm:text-5xl lg:text-[52px]">
                Coins that <span className="text-brand">trade for their holders</span>.
              </h1>
              <p className="mt-4 max-w-[50ch] text-lg leading-relaxed text-ink-2">
                A trading fee of 1 to 5%, always collected in USDG, funds a leveraged perp on Lighter. Realized profits
                buy the coin back and burn it.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button size="xl" nativeButton={false} render={<Link href="/launch" />}>
                  <Sparkles aria-hidden size={16} animateOnHover />
                  Launch a coin
                </Button>
                <Button
                  size="xl"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/docs" />}
                >
                  Read the docs
                </Button>
              </div>
            </div>

            {/* the plate */}
            <div className="relative mx-auto flex w-full max-w-[340px] items-center justify-center">
              <Guilloche
                teeth={26 + coins}
                reach={coins > 0 ? liveEngines / coins : 0.4}
                rings={5}
                size={330}
                className="w-full max-w-[330px] text-brand"
              />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <div className="num text-3xl font-semibold text-ink">
                  <AnimatedNumber value={totalBurned} format="int" countOnMount duration={1.6} />
                </div>
                <div className="mt-1 text-xs tracking-wide text-ink-3">tokens burned</div>
              </div>
            </div>
          </div>
        </section>
      </RevealBlock>
    </Container>
  );
}
