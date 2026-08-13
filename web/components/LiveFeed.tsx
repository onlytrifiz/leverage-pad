"use client";

import { useEffect, useState } from "react";
import type { FeedItem } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { explorerTx } from "@/lib/clientConfig";

const TONE: Record<FeedItem["tone"], string> = {
  up: "text-up-bright",
  down: "text-down-bright",
  accent: "text-accent-bright",
  plain: "text-ink-2",
};

/** gli eventi del protocollo (burn, buyback, payout, deposito perp) hanno la
 *  strip verde di sfondo — i trade restano righe piatte con il segno colorato */
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
    <div className="panel">
      <div className="panel-head">
        <span className="lbl">live feed</span>
        <span className="lbl">
          {items?.length ? `last event ${timeAgo(items[0].ts, now)}` : ""}
        </span>
      </div>
      <div className="max-h-[420px] overflow-y-auto p-1.5">
        {items == null && <div className="lbl px-3 py-6">reading chain events…</div>}
        {items != null && items.length === 0 && (
          <div className="lbl px-3 py-6">no events yet — the keeper writes here as fees flow</div>
        )}
        {items?.map((it, i) => (
          <div
            key={i}
            className={`flex items-baseline justify-between gap-3 rounded px-2.5 py-2 text-[12px] ${
              isProtocol(it.kind) ? "my-0.5 border-l-2 border-accent bg-accent-dim/25" : ""
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
                  className="text-[10px] uppercase tracking-[0.1em] text-ink-3 underline decoration-line underline-offset-2 hover:text-ink-2"
                >
                  tx
                </a>
              )}
            </div>
            <span className="lbl shrink-0 normal-case tracking-normal">{timeAgo(it.ts, now)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
