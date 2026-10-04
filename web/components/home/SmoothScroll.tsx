"use client";

import { useEffect } from "react";
import { ReactLenis, useLenis } from "lenis/react";
import { useReducedMotion } from "motion/react";
import { gsap, ScrollTrigger } from "@/lib/gsap";
import { INTRO_EVENT } from "@/components/intro/boot";

/**
 * Smooth scrolling for the home page only.
 *
 * The landing half of the page is read top to bottom and benefits from the
 * glide; the market half has scrollable rails, which opt out with
 * `data-lenis-prevent`. Product pages (launch, a coin) keep native scrolling.
 *
 * Lenis runs on GSAP's ticker instead of its own requestAnimationFrame, and
 * tells ScrollTrigger about every scroll: two clocks would let the scrubbed
 * sections read a position one frame stale, which shows as a judder exactly
 * where the page is supposed to feel most fluid.
 */
export default function SmoothScroll({ children }: { children: React.ReactNode }) {
  /*
   * The tree is the same for everyone, so server and client agree; reduced
   * motion only turns the smoothing off and the wheel goes back to native.
   */
  const reduced = useReducedMotion() ?? false;

  return (
    <ReactLenis
      root
      options={{ autoRaf: false, lerp: 0.11, smoothWheel: !reduced, anchors: { offset: -80 } }}
    >
      <LenisBridge />
      {children}
    </ReactLenis>
  );
}

/**
 * Wires the instance to GSAP once it exists.
 *
 * ReactLenis creates Lenis in an effect of its own, so on the first render a
 * ref to it is still empty. Reading it from a parent effect and bailing out
 * when empty is how the first version shipped a page that did not scroll at
 * all: Lenis was taking the wheel and nobody was driving its frames.
 * `useLenis()` re-renders with the instance as soon as it is there.
 */
function LenisBridge() {
  const lenis = useLenis();

  useEffect(() => {
    if (!lenis) return;
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    lenis.on("scroll", ScrollTrigger.update);

    const onIntro = (e: Event) => {
      if ((e as CustomEvent<{ open: boolean }>).detail.open) lenis.stop();
      else lenis.start();
    };
    window.addEventListener(INTRO_EVENT, onIntro);
    if (document.documentElement.dataset.intro === "open") lenis.stop();

    return () => {
      gsap.ticker.remove(tick);
      lenis.off("scroll", ScrollTrigger.update);
      window.removeEventListener(INTRO_EVENT, onIntro);
    };
  }, [lenis]);

  return null;
}
