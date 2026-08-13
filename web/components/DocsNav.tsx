"use client";

import { useEffect, useState } from "react";

export type DocsGroup = {
  label: string;
  items: { id: string; title: string }[];
};

/**
 * Indice laterale dei docs con scrollspy: evidenzia la sezione visibile.
 * Le sezioni sono <section id=…> nella pagina; qui solo ancore + observer.
 */
export default function DocsNav({ groups }: { groups: DocsGroup[] }) {
  const [active, setActive] = useState(groups[0]?.items[0]?.id ?? "");

  useEffect(() => {
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // banda di attivazione: sotto la nav sticky, sopra il 65% del viewport
      { rootMargin: "-80px 0px -65% 0px" }
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [groups]);

  return (
    <nav className="space-y-5">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="lbl mb-2">{g.label}</div>
          <ul className="space-y-0.5 border-l border-line">
            {g.items.map((item) => {
              const isActive = item.id === active;
              return (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    className={`-ml-px block border-l py-1 pl-3 text-[12px] leading-snug transition-colors ${
                      isActive
                        ? "border-accent-bright font-semibold text-accent-bright"
                        : "border-transparent text-ink-2 hover:border-line-2 hover:text-ink"
                    }`}
                  >
                    {item.title}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
