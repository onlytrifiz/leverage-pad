"use client";

import { useState } from "react";
import { shortAddr } from "@/lib/format";
import { Copy } from "@/components/animate-ui/icons/copy";
import { ExternalLink } from "@/components/animate-ui/icons/external-link";
import { Check } from "lucide-react";

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
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-2 hover:bg-muted hover:text-ink"
      title={value}
    >
      {label && <span className="text-ink-3">{label}</span>}
      <span className="num">{shortAddr(value)}</span>
      {copied ? (
        <Check aria-hidden className="size-3.5 text-up" />
      ) : (
        <Copy aria-hidden size={14} animateOnHover className="text-ink-3" />
      )}
      <span className="sr-only">{copied ? "Copied" : "Copy address"}</span>
    </button>
  );
}

export function LinkChip({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-2 hover:bg-muted hover:text-ink"
    >
      {label}
      <ExternalLink aria-hidden size={13} animateOnHover className="text-ink-3" />
    </a>
  );
}
