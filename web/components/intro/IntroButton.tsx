"use client";

import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIntro } from "./intro-context";

/** "How it works": replays the story from anywhere. One label for one intent, site-wide. */
export function IntroButton({
  variant = "outline",
  size = "xl",
  className,
}: {
  variant?: "outline" | "ghost" | "link";
  size?: "xl" | "lg" | "default" | "sm";
  className?: string;
}) {
  const { open } = useIntro();
  return (
    <Button type="button" variant={variant} size={size} onClick={open} className={className}>
      <Play aria-hidden className="size-3.5" />
      How it works
    </Button>
  );
}

/** the same action as plain text, for the footer's row of links */
export function IntroLink({ className }: { className?: string }) {
  const { open } = useIntro();
  return (
    <button type="button" onClick={open} className={className}>
      How it works
    </button>
  );
}
