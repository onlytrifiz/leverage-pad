"use client";

import { useRef } from "react";
import { ArrowLeftRight, CircleDollarSign, Flame, Target, TrendingUp } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { gsap, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { FEE_SPLIT_PCT } from "@/lib/doppler";

/**
 * The loop, lit as you read it.
 *
 * Five stations from a swap to a burn. Scrolling through the section scrubs one
 * GSAP timeline: each connector fills and the next station switches on, so the
 * order of the mechanism is the order of the page. Scroll back and it unwinds,
 * which is the honest version of a loop.
 *
 * Under reduced motion the whole circuit is simply drawn lit.
 */

const STEPS = [
  { icon: ArrowLeftRight, title: "A swap", text: "Anyone buys or sells the coin on its pool." },
  {
    icon: CircleDollarSign,
    title: "The fee, in USDG",
    text: `1 to 5%, converted inside the same swap. ${FEE_SPLIT_PCT.engine}% lands in the coin's wallet.`,
  },
  { icon: TrendingUp, title: "A leveraged perp", text: "Opened on Lighter at the asset, side and leverage set at launch." },
  { icon: Target, title: "Take profit", text: "Each deposit banks at the take-profit set at launch, up to +500% at high leverage." },
  { icon: Flame, title: "Buyback & burn", text: "75% of the profit buys the coin and burns it." },
];

export default function EngineLoop() {
  const scope = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      const q = gsap.utils.selector(scope);
      const stations = q(".js-station");
      const links = q(".js-link");
      if (reduced) {
        gsap.set(stations, { "--lit": 1 });
        gsap.set(links, { scaleX: 1, scaleY: 1 });
        return;
      }
      gsap.set(stations, { "--lit": 0 });
      gsap.set(stations[0], { "--lit": 1 });
      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: { trigger: scope.current, start: "top 72%", end: "bottom 55%", scrub: 0.6 },
      });
      links.forEach((link, i) => {
        tl.fromTo(link, { scaleX: 0, scaleY: 0 }, { scaleX: 1, scaleY: 1, duration: 1 }).to(
          stations[i + 1],
          { "--lit": 1, duration: 0.5 },
          "<0.6"
        );
      });
      tl.fromTo(q(".js-return"), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.6 });
      // fonts and images can change the section's height after mount
      ScrollTrigger.refresh();
    },
    { scope, dependencies: [reduced] }
  );

  return (
    <div ref={scope}>
      <ol className="relative grid grid-cols-1 gap-0 md:grid-cols-5 md:gap-0">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <li key={s.title} className="js-station loop-station relative flex gap-4 pb-8 md:block md:pr-6 md:pb-0">
              {/* connector to the next station: across on desktop, down on a phone */}
              {i < STEPS.length - 1 && (
                <span aria-hidden className="absolute top-12 bottom-0 left-[23px] w-[2px] bg-line md:top-[23px] md:right-0 md:bottom-auto md:left-12 md:h-[2px] md:w-auto">
                  <span className="js-link block h-full w-full origin-top bg-brand md:origin-left" />
                </span>
              )}
              <span className="loop-node relative z-10 flex size-12 shrink-0 items-center justify-center rounded-full border-2">
                <Icon size={20} strokeWidth={1.75} aria-hidden />
              </span>
              <div className="min-w-0 md:mt-5">
                <h3 className="loop-title text-lg font-semibold">{s.title}</h3>
                <p className="mt-1.5 max-w-[30ch] text-sm leading-relaxed text-ink-3">{s.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="js-return mt-8 flex items-center gap-3 text-base text-ink-2 md:mt-12">
        <span aria-hidden className="h-px w-10 bg-brand" />
        A scarcer coin draws more trading: more fees, a bigger position, and round again.
      </p>
    </div>
  );
}
