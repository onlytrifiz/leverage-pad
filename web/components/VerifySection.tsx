import type { Coin } from "@/lib/types";
import { CopyChip, LinkChip } from "./CopyChip";
import { explorerAddr, explorerToken } from "@/lib/clientConfig";

/**
 * La sezione anti-fiducia: ogni indirizzo del meccanismo, verificabile su
 * explorer. Se questa dashboard mente, la chain no.
 */
export default function VerifySection({ coin, locker }: { coin: Coin; locker: string }) {
  const rows: { label: string; desc: string; addr: string; href: string }[] = [
    { label: `$${coin.symbol} token`, desc: "Fixed supply, no owner, public burn().", addr: coin.token, href: explorerToken(coin.token) },
    { label: "pool (uniswap v3)", desc: "All supply seeded one-sided at launch.", addr: coin.pool, href: explorerAddr(coin.pool) },
    { label: "locker", desc: `LP NFT #${coin.lpTokenId} locked forever — no owner, no withdraw.`, addr: locker || "—", href: locker ? explorerAddr(locker) : "#" },
    { label: "sub-wallet", desc: "Receives every fee, funds the perp. Derived server-side; keys never leave the keeper.", addr: coin.subWallet, href: explorerAddr(coin.subWallet) },
    { label: "creator", desc: "Recorded at launch — receives a fee share only if the creator split is enabled (0% by default).", addr: coin.creator, href: explorerAddr(coin.creator) },
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="lbl">verify on-chain</span>
      </div>
      <p className="px-4 pt-3 text-[12px] leading-relaxed text-ink-2">
        Don&apos;t trust this dashboard. Every address below is on Robinhood Chain — open it
        in the explorer and confirm the numbers match.
      </p>
      <div className="divide-y divide-line/50 p-2">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-center gap-2 px-2 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">{r.label}</div>
              <div className="mt-0.5 text-[11px] text-ink-3">{r.desc}</div>
            </div>
            {r.addr !== "—" && <CopyChip value={r.addr} />}
            {r.addr !== "—" && <LinkChip label="explorer" href={r.href} />}
          </div>
        ))}
      </div>
    </div>
  );
}
