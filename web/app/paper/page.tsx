export const metadata = { title: "paper · multiply.cash" };

/**
 * Il paper del protocollo: come funziona il motore, cosa garantiscono i
 * contratti, cosa resta responsabilita' dell'operatore. Scritto per chi
 * verifica, non per chi crede sulla parola.
 */

const SECTIONS = [
  { n: "01", id: "engine", title: "The engine" },
  { n: "02", id: "launch", title: "Launch" },
  { n: "03", id: "contracts", title: "What the contracts guarantee" },
  { n: "04", id: "subwallets", title: "Sub-wallet treasuries" },
  { n: "05", id: "markets", title: "Market universe" },
  { n: "06", id: "keeper", title: "The keeper loop" },
  { n: "07", id: "lifecycle", title: "Position lifecycle" },
  { n: "08", id: "tranches", title: "Tranches" },
  { n: "09", id: "profits", title: "Profits, buybacks, burns" },
  { n: "10", id: "economics", title: "Economics" },
  { n: "11", id: "verify", title: "What you can verify" },
  { n: "12", id: "promises", title: "What we don't promise" },
];

const Section = ({ n, id, title, children }: { n: string; id: string; title: string; children: React.ReactNode }) => (
  <section id={id} className="mt-10 scroll-mt-20">
    <h2 className="flex items-baseline gap-3 text-[16px] font-bold tracking-tight">
      <span className="lbl">{n}</span> {title}
    </h2>
    <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-ink-2">{children}</div>
  </section>
);

const K = ({ children }: { children: React.ReactNode }) => <span className="text-ink">{children}</span>;
const N = ({ children }: { children: React.ReactNode }) => <span className="num text-ink">{children}</span>;

export default function PaperPage() {
  return (
    <div className="mx-auto max-w-[760px] pt-10 pb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="lbl">protocol paper · v1</span>
        <a href="/whitepaper.pdf" target="_blank" rel="noreferrer" className="lbl transition-colors hover:text-ink">
          formal version: whitepaper.pdf ↗
        </a>
      </div>
      <h1 className="text-[30px] font-bold leading-tight tracking-tight">
        Coins backed by a <span className="green-glow text-accent-bright">perp treasury</span>.
      </h1>
      <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
        multiply.cash launches coins whose trading fees fund a leveraged perpetual
        position on Lighter — BTC, stocks, even pre-IPO markets. Profits flow back
        on-chain and burn supply. No admin keys, liquidity locked forever, every claim
        in this page verifiable from the explorer.
      </p>

      {/* contents */}
      <div className="panel mt-6 px-5 py-4">
        <div className="lbl mb-3">Contents</div>
        <div className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="flex items-baseline gap-2.5 text-[12.5px] text-ink-2 transition-colors hover:text-ink"
            >
              <span className="lbl">{s.n}</span> {s.title}
            </a>
          ))}
        </div>
      </div>

      <Section n="01" id="engine" title="The engine">
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
          That circuit is the whole product. Fees are not income to be distributed —
          they are working capital. Every swap on the coin makes its position bigger;
          every take-profit on the position makes the coin scarcer. The engine is a
          keeper loop that anyone can audit: every action it takes is a transaction
          from the coin&apos;s own sub-wallet, and its accounting reconciles against
          on-chain balances every tick.
        </p>
        <p>
          Two things are deliberately <em>not</em> in the circuit: a bonding curve and
          a graduation event. The pool seeded at launch is the coin&apos;s market for
          life — no migration, no LP token, no moment where liquidity changes hands.
        </p>
      </Section>

      <Section n="02" id="launch" title="Launch">
        <p>
          <K>The token.</K> A standard ERC20 with fixed <N>1,000,000,000</N> supply,
          minted once in the constructor. No owner, no admin functions, no transfer
          tax, no mint after deploy, no pause, no blacklist. There is nothing to
          renounce — authority over the token never exists in the first place.
        </p>
        <p>
          <K>The pool.</K> The entire supply goes into a canonical Uniswap V3 pool
          against USDG as a single one-sided position: an ask ladder starting at
          roughly <N>$4,000</N> market cap. Every coin opens at the same valuation,
          whatever market or leverage it picked. Buys and sells are ordinary V3 swaps,
          routable by anything that speaks Uniswap — multiply.cash never custodies
          user balances.
        </p>
        <p>
          <K>The fee.</K> The pool&apos;s fee tier is <N>1%</N>. That is a pool
          parameter, not a token tax: there is no fee anywhere in the token contract.
          Every swap in either direction pays 1% into the locked liquidity position,
          and that trickle funds everything else in this page.
        </p>
        <p>
          <K>The lock.</K> In the same launch flow, the LP NFT is transferred into the
          locker with its two destinations — burn side and fee recipient — encoded in
          the transfer itself. From that block on, the liquidity is nobody&apos;s to
          take.
        </p>
      </Section>

      <Section n="03" id="contracts" title="What the contracts guarantee">
        <p>Two contracts, both without owners, both immutable after deploy:</p>
        <p>
          <K>MultiplyToken</K> — fixed supply, no mint, no taxes, no admin. Burning is
          first-class: <N>burn()</N> or a plain transfer to 0xdEaD both reduce{" "}
          <N>totalSupply</N> on-chain, so no phantom supply ever parks on the dead
          address. Transfers to the zero address revert, like any sane ERC20 — burns
          are always explicit.
        </p>
        <p>
          <K>MultiplyLocker</K> — the LP NFT enters and never leaves: no withdraw, no
          transfer, no decreaseLiquidity, no upgrade path, no emergency recovery. The
          only entry point is the ERC721 receive hook, which registers the position
          exactly once — recipient and burn token can never be re-pointed.{" "}
          <N>collect()</N> is public and has exactly one outcome: the coin side of the
          fees goes straight to 0xdEaD (a real burn), the USDG side goes to the
          registered sub-wallet.{" "}
          <K>The burn is enforced by the contract, not by our bot</K> — it works even
          if the keeper is offline, for anyone willing to pay gas. A per-side collect
          exists as a rescue path if one token ever freezes; its destinations are the
          same.
        </p>
        <p>
          A rug in the ordinary sense — deployer withdraws the pool and walks — is not
          a thing that can happen here. Not for the creator, not for multiply.cash.
          There is no LP token to unstake and no timelock that eventually opens.
        </p>
      </Section>

      <Section n="04" id="subwallets" title="Sub-wallet treasuries">
        <p>
          <K>One wallet per coin.</K> Each coin gets its own address at launch. That
          address is the locker&apos;s registered fee recipient and the owner of the
          coin&apos;s Lighter account. Funds for one coin can never touch another
          coin&apos;s position, and every sub-wallet is public on the explorer.
        </p>
        <p>
          <K>Who holds the keys.</K> Sub-wallet keys are derived deterministically
          from a single master secret — an HMAC-SHA256 over the token&apos;s address —
          so they exist only inside the keeper process. Never stored in a database,
          never handed to a browser, never shown to the person who launched the coin.
          The creator&apos;s own wallet is only ever a payout destination.
        </p>
        <p>
          <K>Why nobody can drain the position.</K> The perp sits behind the same
          wall. Each coin&apos;s Lighter account is opened under its own sub-wallet,
          and Lighter only accepts orders signed by the account&apos;s key. A creator
          cannot drain, close, or borrow against the position backing their coin — and
          neither can the creator of any other coin. The backing is operated by the
          keeper on a fixed policy, in public, or not at all.
        </p>
      </Section>

      <Section n="05" id="markets" title="Market universe">
        <p>
          The menu is Lighter&apos;s, not ours: any perp listed on Lighter&apos;s
          Robinhood deployment can back a coin — crypto majors, US stocks, pre-IPO
          names. The catalog is re-synced from the venue as markets are listed,
          roughly <N>39 markets</N> today.
        </p>
        <p>
          At launch the creator picks the market, the side (long or short) and the
          leverage: <N>2x, 3x, 5x, 10x or 20x</N>. Positions run{" "}
          <K>isolated margin</K> — a coin&apos;s position can only ever lose the
          collateral it has posted, never more. Higher leverage means faster burns on
          a good call, faster liquidation on a bad one.
        </p>
      </Section>

      <Section n="06" id="keeper" title="The keeper loop">
        <p>
          A keeper bot ticks every <N>15 seconds</N>. For every coin, each tick, in
          order:
        </p>
        <ul className="space-y-2">
          {[
            <>credits any perp withdrawal that landed since the last tick — bridge
              settlements are recognized from the on-chain transfer itself and split
              25% treasury / 75% buyback;</>,
            <>sweeps stray USDG into the perp reserve, so even mis-sent funds end up
              working for the coin;</>,
            <>claims fees from the locker once they&apos;re worth more than{" "}
              <N>$0.50</N> — coin side burns, USDG side lands in the sub-wallet;</>,
            <>burns the sub-wallet&apos;s <K>entire</K> coin balance — every tick,
              everything;</>,
            <>runs the buyback when the reserve clears <N>$25</N>;</>,
            <>marks the perp to market and decides: deposit, top up, or take
              profit.</>,
          ].map((item, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="text-accent-bright">▪</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p>
          <K>Crash safety.</K> Every bucket is checkpointed before the transaction is
          sent, so a crash at any point under-pays for one tick instead of paying
          twice. An ambiguous outcome — sent but unconfirmed — becomes a pending
          record and is reconciled against on-chain evidence; it is never blindly
          re-sent.
        </p>
      </Section>

      <Section n="07" id="lifecycle" title="Position lifecycle">
        <p>
          <K>Open at $20.</K> Once <N>$20</N> of fees have accrued, the keeper
          deposits into the coin&apos;s Lighter account and opens the position at the
          chosen market, side and leverage. Deposits travel as plain USDG transfers to
          a deterministic intent address; Lighter credits the coin&apos;s own account
          across the bridge.
        </p>
        <p>
          <K>Top up every $20.</K> Every further <N>$20</N> of fees is deposited and
          put to work at the same leverage, as a market order with a <N>2%</N>{" "}
          slippage cap.
        </p>
        <p>
          <K>Losses.</K> If price moves against the position, nothing closes at a loss
          and nothing averages down. Underwater tranches simply wait. New fees still
          open new tranches at the current mark — each runs at its own target from
          where it entered. The contract-enforced fee burn continues regardless.
        </p>
        <p>
          <K>Liquidation.</K> If the venue liquidates the position, the posted
          collateral is gone and the tranche book zeroes out. That is the whole blast
          radius: the pool, the locked liquidity and holder balances are untouched,
          and the engine restarts from the next $20 of fees.
        </p>
      </Section>

      <Section n="08" id="tranches" title="Tranches — every dollar has its own target">
        <p>
          The position on Lighter is one netted position, but the engine tracks every
          deposit as a <K>tranche</K> with its own entry price. A tranche takes profit
          when the underlying moves <N>trigger ÷ leverage</N> from <em>its</em> entry
          — which is exactly <N>+trigger</N> on that tranche&apos;s own collateral.
          New fees never dilute an old tranche&apos;s progress. The trigger is the
          coin&apos;s risk profile, fixed at launch:
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
        <p>
          Concretely: a 5x <K>safe</K> coin banks each tranche on a 4% move of the
          underlying; a 2x <K>degen</K> coin demands 50%.
        </p>
        <p>
          <K>Banking a tranche.</K> When a tranche matures, the keeper closes exactly
          that tranche&apos;s size — reduce-only, at market, fill-verified: the
          position is re-read after the order and profit is credited only for what
          actually closed. Freed collateral re-enters as a fresh tranche at the
          current mark, so banked capital keeps compounding.
        </p>
        <p>
          <K>Ring-fencing.</K> Realized profit is excluded from what the keeper can
          redeploy. Profit destined for burns can never be re-risked on the position
          it came from — it can only leave toward the buyback.
        </p>
        <p>
          <K>The venue is the truth.</K> The tranche book only ever converges toward
          what Lighter reports: position gone means the book zeroes; smaller than the
          book means tranches rescale pro-rata; larger means the excess becomes a
          synthetic tranche at the current entry.
        </p>
      </Section>

      <Section n="09" id="profits" title="Profits, buybacks, burns">
        <p>
          <K>Coming home.</K> Once realized profit clears <N>$25</N>, it&apos;s
          withdrawn from Lighter over the zk bridge (~15 minutes) back to the
          coin&apos;s sub-wallet, where it splits <K>25% protocol treasury / 75%
          buyback reserve</K>.
        </p>
        <p>
          <K>The buyback.</K> When a coin&apos;s buyback reserve crosses <N>$25</N>,
          the keeper buys the coin on its own pool and burns what it bought. A single
          tick spends at most <N>$25</N>, with a minimum-out quoted from the live pool
          price minus 3% — a large reserve drains as a series of ordinary buys rather
          than one block-moving order.
        </p>
        <p>
          <K>Two burn channels, one number.</K> The fee-side burn is enforced by the
          locker on every claim and survives the keeper; the buyback burn is funded by
          realized profit. Both — plus any holder who sends to 0xdEaD on their own —
          show up in <N>initial supply − totalSupply</N>, the burn figure every page
          of this site reports.
        </p>
      </Section>

      <Section n="10" id="economics" title="Economics">
        <p>
          Full degen split: <K>100% of trading fees fund the perp treasury</K>. No
          creator cut, no fee skim. The protocol earns only when the engine wins: 25%
          of realized profits, with the other 75% buying and burning supply. If the
          position never profits, the protocol earns nothing — incentives point the
          same way as holders&apos;. No launch fee either.
        </p>
        <p>
          Worst case is bounded by design: isolated margin means a liquidation costs
          the treasury&apos;s allocated collateral, never more. The engine then starts
          re-accumulating from the next fee.
        </p>
        <p>
          One honest caveat on exposure: the coin&apos;s spot price does not
          mechanically track its underlying. Exposure reaches holders as{" "}
          <K>realized flows</K> — take-profits that become buybacks and burns — not as
          a continuously repricing reserve. That looseness is what keeps a liquidation
          from ever touching the pool.
        </p>
      </Section>

      <Section n="11" id="verify" title="What you can verify">
        <p>
          Every launch, lock, fee claim, burn, deposit and buyback is a confirmed
          transaction on Robinhood Chain. Each coin&apos;s page links its addresses
          out to the explorer: the token (fixed supply, no owner, public burn()), the
          pool, the locker (LP NFT locked forever), the sub-wallet, the live Lighter
          account.
        </p>
        <p>
          The accounting closes: USDG into a sub-wallet matches locker claims plus
          perp withdrawals; USDG out matches Lighter deposits and buyback swaps, which
          match on-chain burns and venue position deltas.
        </p>
        <p>
          <K>Don&apos;t trust this page.</K> Open the explorer and confirm the numbers
          match.
        </p>
      </Section>

      <Section n="12" id="promises" title="What we don't promise">
        <p>
          The keeper is a live dependency: if it stops, claims and deposits pause (the
          contract-level burn keeps working). The perp leg carries real market risk —
          leverage cuts both ways, and a coin&apos;s treasury can be liquidated. The
          master secret that derives sub-wallets is held by the operator: it cannot
          rug the liquidity (the locker makes that impossible) but it does control the
          flow of collected fees. Lighter, its zk bridge and RPC providers are all
          moving parts — an outage on any of them pauses deposits, take-profits or
          withdrawals until it recovers.
        </p>
        <p>
          Read the contracts, check the addresses, verify the burns. Then pick a
          market, a side, a leverage, and a coin you actually believe in.
        </p>
      </Section>

      <div className="lbl mt-12 border-t border-line pt-4">
        uniswap v3 · lighter · robinhood chain — verify everything
      </div>
    </div>
  );
}
