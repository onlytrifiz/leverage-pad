import type { Coin } from "@/lib/types";
import { CopyChip, LinkChip } from "./CopyChip";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { LockKeyhole } from "@/components/animate-ui/icons/lock-keyhole";
import { DOPPLER, V4_POOL_MANAGER, LAUNCH_ROUTER, explorerAddr, explorerToken } from "@/lib/clientConfig";
import { dexscreenerPool } from "@/lib/doppler";

/**
 * Every address in the mechanism, in the one place a reader who wants
 * provenance goes looking for it. It states what each contract is and links out;
 * it does not argue for its own honesty.
 */
export default function VerifySection({ coin }: { coin: Coin }) {
  const rows: { label: string; desc: string; addr: string; href: string; hrefLabel?: string }[] = [
    {
      label: `$${coin.symbol} token`,
      desc: "Doppler ERC-20: fixed supply, no mint, public burn(). Its owner is the Airlock, which has no function to use that power.",
      addr: coin.token,
      href: explorerToken(coin.token),
    },
    {
      label: "Pool (Uniswap v4)",
      desc: "Pool id on the PoolManager. All supply seeded one-sided at launch; locked by its beneficiaries, nobody can pull it.",
      addr: coin.poolId,
      href: dexscreenerPool(coin.poolId),
      hrefLabel: "DexScreener",
    },
    {
      label: "Hook: DopplerHookInitializer",
      desc: "The v4 hook that holds the liquidity. Locked status: no exit, no withdraw, no admin.",
      addr: DOPPLER.hookInitializer,
      href: explorerAddr(DOPPLER.hookInitializer),
    },
    {
      label: "Fee hook: Rehype",
      desc: `Takes the ${coin.fee / 10000}% trading fee and converts it to USDG in the same swap. 5% of it goes to Doppler.`,
      addr: DOPPLER.rehype,
      href: explorerAddr(DOPPLER.rehype),
    },
    {
      label: "Fee destination",
      desc: "Where the USDG lands: the engine hub until the keeper adopts the coin, then the coin's own sub-wallet.",
      addr: coin.subWallet,
      href: explorerAddr(coin.subWallet),
    },
    {
      label: "Launch router",
      desc: "multiply.cash router in front of the Airlock: enforces the launch shape, never touches a pool afterwards.",
      addr: LAUNCH_ROUTER,
      href: explorerAddr(LAUNCH_ROUTER),
    },
    {
      label: "PoolManager",
      desc: "Uniswap v4 singleton on Robinhood Chain.",
      addr: V4_POOL_MANAGER,
      href: explorerAddr(V4_POOL_MANAGER),
    },
    {
      label: "Creator",
      desc: "Wallet that launched the coin, recorded in the metadata it signed.",
      addr: coin.creator,
      href: explorerAddr(coin.creator),
    },
  ];

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle className="flex items-center gap-2">
          <LockKeyhole aria-hidden size={16} animateOnView className="text-brand" />
          Addresses
        </PanelTitle>
      </PanelHeader>
      <ul className="divide-y divide-border px-4 sm:px-5">
        {rows.map((r) => (
          <li key={r.label} className="min-w-0 py-3.5">
            <div className="text-md font-semibold text-ink">{r.label}</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{r.desc}</p>
            {r.addr && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <CopyChip value={r.addr} />
                <LinkChip label={r.hrefLabel ?? "Explorer"} href={r.href} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
