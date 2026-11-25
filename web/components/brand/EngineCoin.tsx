import { cn } from "cn";
import { EngravedArt } from "@/components/brand/EngravedArt";
import { LogoMark } from "@/components/brand/LogoMark";

/* the coin's outline in the clip, traced from a frame */
const OUTLINE =
  "polygon(1.6% 44.2%, 2.0% 39.9%, 3.1% 35.0%, 4.8% 30.1%, 7.2% 25.4%, 11.1% 19.6%, 14.8% 15.4%, 20.3% 10.7%, 25.8% 7.3%, 31.6% 4.7%, 38.4% 3.0%, 44.7% 2.1%, 52.0% 1.8%, 56.9% 2.2%, 60.6% 3.0%, 66.9% 5.0%, 73.9% 8.8%, 77.0% 11.0%, 83.3% 16.8%, 86.6% 20.8%, 91.1% 28.2%, 93.1% 32.6%, 95.5% 40.4%, 96.6% 47.3%, 96.4% 58.2%, 95.2% 64.4%, 93.9% 68.2%, 90.8% 74.8%, 88.1% 78.8%, 84.4% 83.2%, 79.2% 87.8%, 75.2% 90.5%, 69.5% 93.2%, 63.9% 95.0%, 55.9% 96.7%, 48.3% 97.2%, 42.2% 96.6%, 36.7% 95.3%, 33.0% 93.9%, 27.5% 91.2%, 22.0% 87.5%, 17.3% 83.4%, 13.4% 79.1%, 9.5% 73.7%, 6.1% 67.5%, 4.4% 63.2%, 2.8% 58.0%, 2.0% 54.2%)";

/**
 * The product in one picture: a coin cut open, with an engine running inside.
 *
 * Only for night surfaces. The clip is mint ink on black; inside its own
 * stacking context it screens onto a night disc cut to the coin's outline, so it
 * needs nothing from what is behind it. Blending with the page instead would
 * break inside any animated parent: a transform or an opacity isolates it, and
 * the black square shows.
 *
 * For visitors who asked for less motion the same engraving stands still; the
 * switch is CSS, so the markup is identical on the server.
 */
export function EngineCoin({ className, mark = true }: { className?: string; mark?: boolean }) {
  return (
    <div aria-hidden className={cn("relative", className)} style={{ aspectRatio: "640 / 674" }}>
      <div className="absolute inset-0 isolate bg-night motion-reduce:hidden" style={{ clipPath: OUTLINE }}>
        <video
          className="h-full w-full mix-blend-screen"
          src="/art/engine.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          tabIndex={-1}
        />
      </div>
      <div className="absolute inset-0 hidden items-center text-mint motion-reduce:flex">
        <EngravedArt name="engine" />
      </div>
      {/* struck on the blank side of the face */}
      {mark && <LogoMark tone="night" optical="display" className="absolute bottom-[20%] left-[20%] size-[32%] opacity-90" />}
    </div>
  );
}
