"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

/**
 * Who decides when the story plays.
 *
 * First visit to the home page: it opens by itself, once per browser. After
 * that only on request, from any "How it works" button or with `?intro` in the
 * URL. The story itself is a separate chunk: a returning visitor never
 * downloads it.
 *
 * Opening and closing are also broadcast as a window event, because the smooth
 * scroller lives inside the home page, below this provider, and has to stop
 * while the overlay owns the screen.
 */

import { SEEN_KEY, INTRO_EVENT, PENDING_CLASS } from "./boot";

export { INTRO_EVENT };

type IntroCtx = { open: () => void; close: () => void; isOpen: boolean };

const Ctx = createContext<IntroCtx>({ open: () => {}, close: () => {}, isOpen: false });

export const useIntro = () => useContext(Ctx);

const StoryIntro = dynamic(() => import("./StoryIntro"), { ssr: false });

/*
 * Whether the story should open by itself, read from the browser. Through
 * useSyncExternalStore the server (and the hydration pass) see `false` and the
 * client switches to the real answer right after, with no effect and no
 * hydration mismatch. Storage blocked (private window, embedded preview)
 * counts as seen: never trap anyone in an intro.
 */
const noSubscribe = () => () => {};
function autoOpenSnapshot() {
  try {
    if (/[?&]intro(=|&|$)/.test(window.location.search)) return true;
    return window.location.pathname === "/" && window.localStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* nothing to do: the worst case is seeing the story again */
  }
}

export function IntroProvider({ children }: { children: React.ReactNode }) {
  // re-render on navigation so the snapshot is read against the current route
  usePathname();
  const auto = useSyncExternalStore(noSubscribe, autoOpenSnapshot, () => false);
  const [dismissed, setDismissed] = useState(false);
  const [requested, setRequested] = useState(false);
  const isOpen = requested || (auto && !dismissed);

  /*
   * Not opening: lift the pre-paint cover the boot script may have set. The
   * hydration pass always reports closed (server snapshot), so the browser's
   * real answer is checked too, or the cover would drop for one frame right
   * before the story opens: the very flash it exists to prevent.
   */
  useEffect(() => {
    if (!isOpen && !autoOpenSnapshot()) document.documentElement.classList.remove(PENDING_CLASS);
  }, [isOpen]);

  useEffect(() => {
    const root = document.documentElement;
    // the event is for listeners already mounted; the attribute for any that mount later
    if (isOpen) root.dataset.intro = "open";
    else delete root.dataset.intro;
    window.dispatchEvent(new CustomEvent(INTRO_EVENT, { detail: { open: isOpen } }));
    if (!isOpen) return;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = prev;
    };
  }, [isOpen]);

  const open = useCallback(() => setRequested(true), []);
  const close = useCallback(() => {
    markSeen();
    setRequested(false);
    setDismissed(true);
    document.documentElement.classList.remove(PENDING_CLASS);
  }, []);

  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {isOpen && <StoryIntro onClose={close} />}
    </Ctx.Provider>
  );
}
