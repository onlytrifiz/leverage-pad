"use client";

import { useEffect, useState } from "react";
import type { FeedItem } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { explorerTx } from "@/lib/clientConfig";
import { AnimatePresence, motion } from "motion/react";
import { Panel, PanelHeader, PanelTitle, PanelMeta } from "@/components/ui/panel";
import { Activity } from "@/components/animate-ui/icons/activity";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

const TONE: Record<FeedItem["tone"], string> = {
  up: "text-up",
  down: "text-down",
  accent: "text-brand",
  plain: "text-ink-2",
};

/** Protocol events (burn, buyback, payout, perp deposit) get the green strip;
 *  trades stay flat rows carrying only the coloured sign. */
const isProtocol = (k: FeedItem["kind"]) =>
  k === "burn" || k === "buyback" || k === "creator" || k === "deposit";

export default function LiveFeed({ address, demo }: { address: string; demo: boolean }) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/coin/${address}/feed`)
        .then((r) => r.json())
        .then((j) => alive && setItems(j.items ?? []))
        .catch(() => alive && setItems([]));
    load();
    const poll = setInterval(load, 15_000);
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [address]);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle className="flex items-center gap-2">
          <Activity
            aria-hidden
            size={16}
            animation="default-loop"
            loop
            loopDelay={2200}
            className="text-brand"
          />
          Live feed
        </PanelTitle>
        <PanelMeta>{items?.length ? `Last event ${timeAgo(items[0].ts, now)}` : ""}</PanelMeta>
      </PanelHeader>
      <div className="max-h-[420px] overflow-y-auto p-2.5">
        {items == null &&
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="mx-1 my-1.5 h-7" />
          ))}
        {items != null && items.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing yet</EmptyTitle>
              <EmptyDescription>Events appear here as fees flow through the engine.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <AnimatePresence initial={false}>
        {items?.map((it, i) => (
          <motion.div
            key={`${it.txHash}-${it.ts}-${i}`}
            layout
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 0.61, 0.36, 1] }}
            className={`flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-sm ${
              isProtocol(it.kind) ? "my-0.5 border-l-2 border-brand bg-brand-soft" : ""
            }`}
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className={it.kind === "tick" ? "text-ink-2" : TONE[it.tone]}>{it.text}</span>
              {it.amountText && <span className={`num ${TONE[it.tone]}`}>{it.amountText}</span>}
              {it.txHash && !demo && (
                <a
                  href={explorerTx(it.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-ink-3 underline decoration-line-2 underline-offset-2 hover:text-ink-2"
                >
                  tx
                </a>
              )}
            </div>
            <span className="shrink-0 text-xs text-ink-3">{timeAgo(it.ts, now)}</span>
          </motion.div>
        ))}
        </AnimatePresence>
      </div>
    </Panel>
  );
}
