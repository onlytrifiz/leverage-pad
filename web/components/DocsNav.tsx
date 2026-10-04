"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";

export type DocsNavGroup = {
  label: string;
  items: { slug: string; title: string }[];
};

const hrefOf = (slug: string) => `/docs/${slug}`;

/**
 * The docs sidebar. Every page is its own route, so the active entry is the
 * pathname, not a scroll position. On a phone the same list folds into a
 * "Contents" disclosure above the article.
 */
export default function DocsNav({ groups, variant = "sidebar" }: { groups: DocsNavGroup[]; variant?: "sidebar" | "mobile" }) {
  const pathname = usePathname();
  const current = groups.flatMap((g) => g.items).find((i) => pathname === hrefOf(i.slug));

  const list = (
    <nav className="space-y-6">
      <Link
        href="/docs"
        className={cn(
          "block text-sm font-medium transition-colors",
          pathname === "/docs" ? "text-brand" : "text-ink-2 hover:text-ink"
        )}
      >
        Overview
      </Link>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-2 text-xs font-semibold tracking-[0.06em] text-ink-3 uppercase">{g.label}</div>
          <ul className="space-y-0.5 border-l border-line">
            {g.items.map((item) => {
              const active = pathname === hrefOf(item.slug);
              return (
                <li key={item.slug}>
                  <Link
                    href={hrefOf(item.slug)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "-ml-px block border-l py-1.5 pl-3 text-sm leading-snug transition-colors",
                      active ? "border-brand font-semibold text-brand" : "border-transparent text-ink-2 hover:border-line-2 hover:text-ink"
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  if (variant === "sidebar") return list;

  return (
    // keyed on the page so it folds again after a navigation
    <details key={pathname} className="group rounded-[14px] border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate">
          <span className="text-ink-3">Contents</span>
          {current && <span className="font-medium text-ink"> · {current.title}</span>}
        </span>
        <ChevronDown size={16} aria-hidden className="shrink-0 text-ink-3 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line px-4 py-4">{list}</div>
    </details>
  );
}
