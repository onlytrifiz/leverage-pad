"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { useGSAP } from "@gsap/react";

/**
 * GSAP, registered once.
 *
 * Every client component imports gsap from here rather than from the package,
 * so the plugins are registered before the first `useGSAP` runs, whichever
 * component happens to mount first. Registering twice is harmless; forgetting
 * once is a silent no-op that looks like a broken animation.
 *
 * Division of labour with Motion: GSAP owns choreography (the intro's timed
 * sequences, the scroll-scrubbed loop), Motion owns UI state. They never drive
 * the same element.
 */
if (typeof window !== "undefined") {
  gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, DrawSVGPlugin);
}

/** the house curve: fast out, long settle, the same one Motion uses site-wide */
export const EASE_OUT = "power3.out";

export { gsap, ScrollTrigger, SplitText, DrawSVGPlugin, useGSAP };
