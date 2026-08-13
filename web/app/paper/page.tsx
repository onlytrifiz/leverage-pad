export const metadata = { title: "paper · multiply.cash" };

/**
 * Il paper del protocollo: come funziona il motore, cosa garantiscono i
 * contratti, cosa resta responsabilita' dell'operatore. Scritto per chi
 * verifica, non per chi crede sulla parola.
 */

const Section = ({ n, title, children }: { n: string; title: string; children: React.ReactNode }) => (
  <section className="mt-10">
    <h2 className="flex items-baseline gap-3 text-[16px] font-bold tracking-tight">
      <span className="lbl">{n}</span> {title}
    </h2>
    <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-ink-2">{children}</div>
  </section>
);

export default function PaperPage() {
  return (
    <div className="mx-auto max-w-[760px] pt-10 pb-8">
      <div className="lbl mb-2">protocol paper · v1</div>
      <h1 className="text-[30px] font-bold leading-tight tracking-tight">
        Coins backed by a <span className="green-glow text-accent-bright">perp treasury</span>.
      </h1>
      <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
        multiply.cash launches coins whose trading fees fund a leveraged perpetual
        position on Lighter — BTC, stocks, even pre-IPO markets. Profits flow back
        on-chain and burn supply. No admin keys, liquidity locked forever, every claim
        in this page verifiable from the explorer.
      </p>

      <Section n="01" title="The engine">
        <p>
          Every coin starts the same way: fixed 1B supply, no owner, all of it seeded
          one-sided into a Uniswap V3 pool at ~$4k market cap, paired with USDG. The LP
          NFT is immediately transferred to the locker, where it stays forever.
        </p>
        <div className="panel overflow-x-auto p-4">
          <pre className="num text-[11px] leading-relaxed text-ink-2">{`swap (1% fee)
  ├─ coin side  → burned by the locker at every collect (trustless)
  └─ USDG side  → sub-wallet → 100% perp treasury
                     └─ deposits to Lighter at the $20 gate
                        opens/tops-up the position chosen at launch
                        (market · direction · leverage · risk profile)

realized profit → withdrawn on-chain
  ├─ 75% buys the coin from the pool and burns it
  └─ 25% protocol treasury (the only protocol revenue)`}</pre>
        </div>
        <p>
          The engine is a keeper loop that anyone can audit: every action it takes is a
          transaction from the coin&apos;s own sub-wallet, and its accounting reconciles
          against on-chain balances every tick.
        </p>
      </Section>

      <Section n="02" title="Tranches — every dollar has its own target">
        <p>
          The position on Lighter is one netted position, but the engine tracks every
          deposit as a <span className="text-ink">tranche</span> with its own entry
          price. A tranche takes profit when the underlying moves{" "}
          <span className="num text-ink">trigger ÷ leverage</span> from <em>its</em>{" "}
          entry — new fees never dilute an old tranche&apos;s progress. When a tranche
          matures, it closes fully (reduce-only, fill-verified) and the profit joins the
          withdraw queue.
        </p>
        <div className="panel grid grid-cols-1 gap-px overflow-hidden bg-line/50 sm:grid-cols-3">
          {[
            { k: "safe", t: "+20%", d: "banks early, banks often" },
            { k: "balanced", t: "+50%", d: "the middle path" },
            { k: "degen", t: "+100%", d: "maximum conviction" },
          ].map((p) => (
            <div key={p.k} className="bg-panel px-4 py-3">
              <div className="text-[12px] font-bold uppercase tracking-[0.1em] text-accent-bright">{p.k}</div>
              <div className="num mt-1 text-[15px] font-semibold">{p.t} per tranche</div>
              <div className="lbl mt-1 normal-case tracking-normal">{p.d}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section n="03" title="What the contracts guarantee">
        <p>
          Two contracts, both without owners, both immutable after deploy:
        </p>
        <p>
          <span className="text-ink">MultiplyToken</span> — fixed supply, no mint, no
          taxes, no admin. Burning is first-class: <span className="num">burn()</span>{" "}
          or a plain transfer to 0xdEaD both reduce <span className="num">totalSupply</span>{" "}
          on-chain. Transfers to the zero address revert, like any sane ERC20.
        </p>
        <p>
          <span className="text-ink">MultiplyLocker</span> — the LP NFT enters and never
          leaves: no withdraw, no transfer, no decreaseLiquidity. <span className="num">collect()</span>{" "}
          is public and has exactly one outcome: the coin side of the fees goes straight
          to 0xdEaD (a real burn), the USDG side goes to the registered sub-wallet.{" "}
          <span className="text-ink">The burn is enforced by the contract, not by our bot</span> —
          it works even if the keeper is offline. A per-side collect exists as a rescue
          path if one token ever freezes.
        </p>
      </Section>

      <Section n="04" title="Economics">
        <p>
          Full degen split: <span className="text-ink">100% of trading fees fund the
          perp treasury</span>. No creator cut, no fee skim. The protocol earns only
          when the engine wins: 25% of realized profits, with the other 75% buying and
          burning supply. If the position never profits, the protocol earns nothing —
          incentives point the same way as holders&apos;.
        </p>
        <p>
          Worst case is bounded by design: isolated margin means a liquidation costs the
          treasury&apos;s allocated collateral, never more. The engine then starts
          re-accumulating from the next fee.
        </p>
      </Section>

      <Section n="05" title="What we don't promise">
        <p>
          The keeper is a live dependency: if it stops, claims and deposits pause (the
          contract-level burn keeps working). The perp leg carries real market risk —
          leverage cuts both ways, and a coin&apos;s treasury can be liquidated. The
          master secret that derives sub-wallets is held by the operator: it cannot rug
          the liquidity (the locker makes that impossible) but it does control the flow
          of collected fees. Read the contracts, check the addresses, verify the burns.
        </p>
      </Section>

      <div className="lbl mt-12 border-t border-line pt-4">
        uniswap v3 · lighter · robinhood chain — verify everything
      </div>
    </div>
  );
}
