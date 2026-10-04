import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Guilloche } from "@/components/brand/Guilloche";
import FinalCta from "@/components/home/FinalCta";
import { RevealBlock } from "@/components/motion";
import { DOC_GROUPS } from "@/components/docs/content";

export const metadata = { title: "Docs" };

/**
 * The docs' front page: what the protocol is, and every page of the docs as a
 * card, grouped as the sidebar groups them.
 * The pages themselves live at /docs/[slug].
 */
export default function DocsIndex() {
  const first = DOC_GROUPS[0].pages[0];
  return (
    <>
      <section className="intro-night relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]">
        <div aria-hidden className="pointer-events-none absolute top-[30%] right-[-14%] -z-10 text-mint/[0.1]">
          <Guilloche teeth={27} reach={0.8} rings={4} size={900} spin={180} className="w-[120vw] max-w-[900px]" />
        </div>
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-10 pb-12 sm:px-5 sm:pt-14 sm:pb-16">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-night-ink-2">
            <span>Protocol docs · v2</span>
            <a href="/whitepaper.pdf" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 transition-colors hover:text-night-ink">
              whitepaper.pdf <ArrowUpRight size={13} aria-hidden />
            </a>
          </div>
          <h1 className="mt-4 font-display text-[clamp(42px,6vw,80px)] leading-[0.98] font-bold tracking-[-0.04em] text-night-ink">
            How the <span className="type-engraved [--ink-c:var(--color-mint)]">engine</span> works.
          </h1>
          <p className="mt-5 max-w-[62ch] text-lg leading-[1.65] text-night-ink-2">
            multiply.cash launches coins whose trading fees fund a leveraged perpetual position on Lighter: BTC,
            stocks, even pre-IPO markets. Profits flow back on-chain and burn supply. The market is a Uniswap v4 pool
            built by Doppler, locked from the first block, with no owner and no admin key.
          </p>
          <Link
            href={`/docs/${first.slug}`}
            className="mt-7 inline-flex h-11 items-center gap-2 rounded-xl bg-mint px-5 text-md font-semibold text-night transition-transform hover:-translate-y-0.5"
          >
            Start with {first.title.toLowerCase()} <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
      </section>

      <div className="mx-auto w-full max-w-[1200px] px-4 pt-14 pb-16 sm:px-5">
        <div className="space-y-12">
          {DOC_GROUPS.map((g) => (
            <RevealBlock key={g.label}>
              <section>
                <h2 className="mb-4 text-xs font-semibold tracking-[0.06em] text-ink-3 uppercase">{g.label}</h2>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {g.pages.map((p) => (
                    <li key={p.slug} className="min-w-0">
                      <Link
                        href={`/docs/${p.slug}`}
                        className="group flex h-full flex-col rounded-[18px] border border-border bg-card p-5 transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[0_10px_28px_-14px_rgba(12,52,32,0.3)]"
                      >
                        <span className="flex items-center justify-between">
                          <span className="num text-sm font-medium text-brand">{String(p.n).padStart(2, "0")}</span>
                          <ArrowRight
                            size={16}
                            aria-hidden
                            className="text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
                          />
                        </span>
                        <span className="mt-3 font-display text-xl font-semibold tracking-[-0.01em] text-ink">{p.title}</span>
                        <span className="mt-1.5 text-sm leading-relaxed text-ink-3">{p.lede}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            </RevealBlock>
          ))}
        </div>

        <div className="mt-16">
          <FinalCta />
        </div>
      </div>
    </>
  );
}
