"use client";

import { useState } from "react";
import { shortAddr } from "@/lib/format";

export function CopyChip({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded border border-line bg-panel px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
      title={value}
    >
      {label && <span className="text-ink-3">{label}</span>}
      <span className="num">{shortAddr(value)}</span>
      <span className={copied ? "text-up-bright" : "text-ink-3"}>{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

export function LinkChip({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded border border-line bg-panel px-2 py-1 text-[11px] uppercase tracking-[0.1em] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
    >
      {label} <span className="text-ink-3">↗</span>
    </a>
  );
}
