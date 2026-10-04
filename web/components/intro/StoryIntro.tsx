"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Pause, Play, X } from "lucide-react";
import { cn } from "cn";
import { gsap } from "@/lib/gsap";
import { SLIDES } from "./slides";

/**
 * The story: how a coin works, told in seven chapters before the site.
 *
 * It behaves like the stories format people already know. It plays by itself,
 * a tap on the right goes forward and on the left goes back, a swipe does the
 * same, and holding a finger down freezes everything so a number can be read.
 * The keyboard gets the same controls (arrows, space, Escape).
 *
 * Timing is GSAP's: the active chapter's bar is one tween, and when it ends the
 * next chapter starts. Pausing that tween and the chapter's own timeline is a
 * single boolean. Motion only handles the cross-fade between chapters.
 *
 * Reduced motion: nothing advances by itself and every chapter arrives in its
 * final state. The story is still all there, one tap at a time.
 */
export default function StoryIntro({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion() ?? false;
  const [index, setIndex] = useState(0);
  const [holding, setHolding] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const paused = holding || userPaused || reduced;

  const dialogRef = useRef<HTMLDivElement>(null);
  const fills = useRef<(HTMLSpanElement | null)[]>([]);
  const tween = useRef<gsap.core.Tween | null>(null);
  const press = useRef<{ x: number; y: number; timer: number; held: boolean } | null>(null);

  const last = SLIDES.length - 1;
  const next = useCallback(() => setIndex((i) => Math.min(i + 1, last)), [last]);
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  // the overlay is up: lift the pre-paint cover and take focus
  useEffect(() => {
    document.documentElement.classList.remove("intro-pending");
    dialogRef.current?.focus();
  }, []);

  // one tween per chapter drives its bar; finishing it is what advances
  useEffect(() => {
    fills.current.forEach((el, i) => {
      if (el) gsap.set(el, { scaleX: i < index ? 1 : 0 });
    });
    const el = fills.current[index];
    const seconds = SLIDES[index].seconds;
    tween.current?.kill();
    if (!el) return;
    if (reduced || !seconds) {
      gsap.set(el, { scaleX: 1 });
      tween.current = null;
      return;
    }
    tween.current = gsap.fromTo(
      el,
      { scaleX: 0 },
      { scaleX: 1, duration: seconds, ease: "none", onComplete: next }
    );
    return () => {
      tween.current?.kill();
    };
  }, [index, reduced, next]);

  useEffect(() => {
    tween.current?.paused(paused);
  }, [paused, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === " " && !(e.target as HTMLElement)?.closest("a,button")) {
        e.preventDefault();
        setUserPaused((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose]);

  /*
   * One pointer handler set for tap, swipe and hold. Anything interactive
   * inside a chapter (the final CTAs) keeps its own click.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("a,button")) return;
    const timer = window.setTimeout(() => {
      if (press.current) press.current.held = true;
      setHolding(true);
    }, 220);
    press.current = { x: e.clientX, y: e.clientY, timer, held: false };
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    window.clearTimeout(p.timer);
    if (p.held) {
      setHolding(false);
      return;
    }
    const dx = e.clientX - p.x;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(e.clientY - p.y)) {
      if (dx < 0) next();
      else prev();
      return;
    }
    const w = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX - w.left < w.width * 0.3) prev();
    else next();
  };

  const onPointerCancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setHolding(false);
  };

  const Slide = SLIDES[index].Component;

  return (
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="How multiply.cash works"
      tabIndex={-1}
      className="intro-night fixed inset-0 z-[60] flex flex-col overflow-hidden text-night-ink outline-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* top bar */}
      <div className="relative z-10 order-1 mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 pt-[max(16px,env(safe-area-inset-top))] sm:px-8 sm:pt-6">
        <span className="flex items-center gap-2">
          <Image src="/logo-transparent.png" alt="" width={26} height={26} priority />
          <span className="font-display text-lg font-bold tracking-tight">
            multiply<span className="text-mint">.cash</span>
          </span>
        </span>
        <div className="flex items-center gap-2">
          {!reduced && SLIDES[index].seconds > 0 && (
            <button
              type="button"
              onClick={() => setUserPaused((p) => !p)}
              aria-label={userPaused ? "Play" : "Pause"}
              className="inline-flex size-9 items-center justify-center rounded-lg border border-night-line text-night-ink-2 transition-colors hover:border-night-ink-2 hover:text-night-ink"
            >
              {userPaused ? <Play size={15} /> : <Pause size={15} />}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-night-line px-3 text-sm font-medium text-night-ink transition-colors hover:border-night-ink-2"
          >
            Skip intro
            <X size={14} aria-hidden />
          </button>
        </div>
      </div>

      {/* stage: tap, swipe and hold land here */}
      <div
        className="relative z-0 order-3 flex min-h-0 flex-1 cursor-pointer select-none touch-pan-y lg:order-2"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={index}
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.01 }}
            transition={{ duration: reduced ? 0 : 0.28 }}
          >
            <Slide paused={paused} reduced={reduced} onClose={onClose} />
          </motion.div>
        </AnimatePresence>

        {index === 0 && !reduced && (
          <span className="pointer-events-none absolute bottom-[max(20px,env(safe-area-inset-bottom))] left-1/2 hidden -translate-x-1/2 animate-pulse text-xs whitespace-nowrap text-night-ink-2 pointer-coarse:block">
            Tap to continue, hold to pause
          </span>
        )}

        {holding && (
          <span className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-night-2 px-3 py-1 text-xs text-night-ink-2">
            Paused
          </span>
        )}
      </div>

      {/* chapters */}
      <nav
        aria-label="Chapters"
        className="relative z-10 order-2 mx-auto grid w-full max-w-[1400px] gap-1.5 px-4 pt-2 sm:gap-3 sm:px-8 lg:order-3 lg:pt-0 lg:pb-7"
        style={{ gridTemplateColumns: `repeat(${SLIDES.length}, minmax(0, 1fr))` }}
      >
        {SLIDES.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setIndex(i)}
            aria-current={i === index ? "step" : undefined}
            aria-label={`Chapter ${i + 1}: ${s.label}`}
            className="group min-w-0 py-1.5 text-left lg:py-2"
          >
            <span
              className={cn(
                "mb-2 hidden truncate text-2xs font-semibold tracking-[0.14em] uppercase transition-colors lg:block",
                i === index ? "text-night-ink" : "text-night-ink-2/70 group-hover:text-night-ink-2"
              )}
            >
              {s.label}
            </span>
            <span className="block h-[3px] overflow-hidden rounded-full bg-night-line">
              <span
                ref={(el) => {
                  fills.current[i] = el;
                }}
                className="block h-full origin-left scale-x-0 rounded-full bg-mint"
              />
            </span>
          </button>
        ))}
      </nav>
    </motion.div>
  );
}
