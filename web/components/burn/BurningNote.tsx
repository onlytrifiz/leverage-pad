"use client";

import { useId } from "react";
import { cn } from "cn";
import { fmtInt } from "@/lib/format";
import { Guilloche } from "@/components/brand/Guilloche";
import { LogoMark } from "@/components/brand/LogoMark";

/**
 * The platform token's supply as one banknote, burning from its right edge.
 *
 * The paper left is the supply left. A burn is a small part of a billion for a long time, so the
 * edge starts where a burn can be seen at all and moves with the square root of the share; the
 * figure printed under it is exact. Until the token is live the note is whole.
 */
const W = 1000;
const H = 470;

/** the charred edge, always the same tear: a deterministic walk down the right side */
function edge(x: number) {
  const pts: [number, number][] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y <= H; y += 12) pts.push([x + Math.sin(y / 46) * 14 + (rnd() - 0.5) * 22, y]);
  return pts;
}

export function BurningNote({ symbol, burned, supply, className }: { symbol: string; burned: number; supply: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const share = supply > 0 ? Math.min(1, burned / supply) : 0;
  const lit = share > 0;
  const x = lit ? W - Math.max(56, Math.sqrt(share) * W * 0.7) : W + 60;
  const line = edge(x).map(([px, py]) => `${px.toFixed(1)},${py}`);
  const paper = `M0,0L${line.join("L")}L0,${H}Z`;
  const rim = `M${line.join("L")}`;

  return (
    <div className={cn("relative aspect-[1000/470] w-full", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <defs>
          <clipPath id={`paper-${id}`}>
            <path d={paper} />
          </clipPath>
          <linearGradient id={`char-${id}`} gradientUnits="userSpaceOnUse" x1={x - 90} x2={x + 10} y1="0" y2="0">
            <stop offset="0" stopColor="#06130c" stopOpacity="0" />
            <stop offset="0.75" stopColor="#1a0f08" stopOpacity="0.72" />
            <stop offset="1" stopColor="#0a0503" stopOpacity="0.96" />
          </linearGradient>
          <filter id={`glow-${id}`} x="-40%" y="-10%" width="180%" height="120%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>
        {/* the ghost of the paper already gone */}
        {lit && <rect x="1" y="1" width={W - 2} height={H - 2} rx="16" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 7" />}
        <g clipPath={`url(#paper-${id})`}>
          <rect width={W} height={H} rx="16" fill="#eef6f0" />
          <rect x="16" y="16" width={W - 32} height={H - 32} rx="10" fill="none" stroke="#0c3420" strokeOpacity="0.5" strokeWidth="2" />
          <rect x="30" y="30" width={W - 60} height={H - 60} rx="6" fill="none" stroke="#0c3420" strokeOpacity="0.35" strokeWidth="1" />
          <text x="434" y="128" fill="#0c3420" fillOpacity="0.7" fontSize="24" letterSpacing="7" fontWeight="600">
            MULTIPLY.CASH
          </text>
          <text x="431" y="226" fill="#0c3420" fontSize="78" fontWeight="700" letterSpacing="-3" className="font-display">
            ${symbol}
          </text>
          <text x="434" y="284" fill="#0c3420" fillOpacity="0.75" fontSize="27">
            One billion, and fewer every time
          </text>
          <text x="434" y="317" fill="#0c3420" fillOpacity="0.75" fontSize="27">
            the protocol earns.
          </text>
          <text x="434" y="398" fill="#b3261e" fillOpacity="0.85" fontSize="26" className="num" letterSpacing="3">
            {fmtInt(Math.max(0, supply - burned))}
          </text>
          {lit && <rect width={W} height={H} fill={`url(#char-${id})`} />}
        </g>
        {lit && (
          <g className="burn-rim" fill="none" strokeLinejoin="round">
            <path d={rim} stroke="#ff7a2f" strokeOpacity="0.75" strokeWidth="14" filter={`url(#glow-${id})`} />
            <path d={rim} stroke="#ffd08a" strokeWidth="3" />
          </g>
        )}
      </svg>
      <span aria-hidden className="absolute top-[12%] left-[6%] flex h-[76%] w-[36%] items-center justify-center">
        <span className="absolute inset-0 flex items-center justify-center text-[#0c3420]/35">
          <Guilloche teeth={37} reach={0.82} rings={4} size={360} spin={0} className="h-full w-auto" />
        </span>
        <LogoMark optical="display" className="relative h-[46%] w-auto" />
      </span>
    </div>
  );
}
