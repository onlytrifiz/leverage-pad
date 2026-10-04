import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import DocsNav from "@/components/DocsNav";
import { Guilloche } from "@/components/brand/Guilloche";
import { DOC_NAV, DOC_PAGES } from "@/components/docs/content";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = DOC_PAGES.find((p) => p.slug === slug);
  return page ? { title: `${page.title} · Docs`, description: page.lede } : {};
}

/**
 * One docs page: a short night band with its number and lede, then the
 * sidebar and the article, and the way on to the next page at the bottom.
 */
export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const i = DOC_PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) notFound();
  const page = DOC_PAGES[i];
  const prev = DOC_PAGES[i - 1];
  const next = DOC_PAGES[i + 1];
  const Body = page.body;

  return (
    <>
      <section className="intro-night behind-nav relative isolate overflow-hidden rounded-b-[28px] text-night-ink sm:rounded-b-[40px]">
        <div aria-hidden className="pointer-events-none absolute top-1/2 right-[-18%] -z-10 -translate-y-1/2 text-mint/[0.1] sm:right-[-6%]">
          <Guilloche
            teeth={17 + page.n * 2}
            reach={0.8}
            rings={3}
            size={620}
            spin={160}
            direction={page.n % 2 ? 1 : -1}
            className="w-[90vw] max-w-[620px]"
          />
        </div>
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-10 sm:px-5 sm:pt-10 sm:pb-12">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-night-ink-2">
            <Link href="/docs" className="transition-colors hover:text-night-ink">
              Docs
            </Link>
            <span aria-hidden>/</span>
            <span>{page.group}</span>
          </nav>
          <div className="num mt-6 text-sm font-medium text-mint">{String(page.n).padStart(2, "0")}</div>
          <h1 className="mt-1 max-w-[20ch] font-display text-[clamp(36px,5vw,60px)] leading-[1.02] font-bold tracking-[-0.035em] text-night-ink">
            {page.title}
          </h1>
          <p className="mt-4 max-w-[56ch] text-lg leading-relaxed text-night-ink-2">{page.lede}</p>
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-[1200px] gap-12 px-4 pt-10 pb-16 sm:px-5 sm:pt-12">
        <aside className="sticky top-20 hidden h-fit w-[210px] shrink-0 self-start lg:block">
          <DocsNav groups={DOC_NAV} />
          <a
            href="/whitepaper.pdf"
            target="_blank"
            rel="noreferrer"
            className="mt-6 flex items-center gap-1 border-t border-line pt-4 text-sm text-ink-3 transition-colors hover:text-ink"
          >
            whitepaper.pdf <ArrowUpRight size={13} aria-hidden />
          </a>
        </aside>

        <div className="min-w-0 max-w-[720px] flex-1">
          <div className="mb-8 lg:hidden">
            <DocsNav groups={DOC_NAV} variant="mobile" />
          </div>

          <article className="space-y-4 text-base leading-[1.7] text-ink-2">
            <Body />
          </article>

          <nav aria-label="Docs pages" className="mt-14 grid grid-cols-1 gap-3 border-t border-line pt-8 sm:grid-cols-2">
            {prev ? (
              <Link
                href={`/docs/${prev.slug}`}
                className="group min-w-0 rounded-[14px] border border-border bg-card px-4 py-3.5 transition-colors hover:border-brand/40"
              >
                <span className="flex items-center gap-1.5 text-xs text-ink-3">
                  <ArrowLeft size={13} aria-hidden /> Previous
                </span>
                <span className="mt-1 block truncate font-medium text-ink group-hover:text-brand">{prev.title}</span>
              </Link>
            ) : (
              <Link
                href="/docs"
                className="group min-w-0 rounded-[14px] border border-border bg-card px-4 py-3.5 transition-colors hover:border-brand/40"
              >
                <span className="flex items-center gap-1.5 text-xs text-ink-3">
                  <ArrowLeft size={13} aria-hidden /> Back
                </span>
                <span className="mt-1 block truncate font-medium text-ink group-hover:text-brand">Overview</span>
              </Link>
            )}
            {next ? (
              <Link
                href={`/docs/${next.slug}`}
                className="group min-w-0 rounded-[14px] border border-border bg-card px-4 py-3.5 text-right transition-colors hover:border-brand/40"
              >
                <span className="flex items-center justify-end gap-1.5 text-xs text-ink-3">
                  Next <ArrowRight size={13} aria-hidden />
                </span>
                <span className="mt-1 block truncate font-medium text-ink group-hover:text-brand">{next.title}</span>
              </Link>
            ) : (
              <Link
                href="/launch"
                className="group min-w-0 rounded-[14px] border border-brand bg-brand-soft px-4 py-3.5 text-right transition-colors hover:bg-brand hover:text-white"
              >
                <span className="flex items-center justify-end gap-1.5 text-xs text-brand group-hover:text-white/80">
                  Ready <ArrowRight size={13} aria-hidden />
                </span>
                <span className="mt-1 block truncate font-medium text-brand group-hover:text-white">Launch a coin</span>
              </Link>
            )}
          </nav>
        </div>
      </div>
    </>
  );
}
