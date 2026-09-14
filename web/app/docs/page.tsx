import DocsNav, { type DocsGroup } from "@/components/DocsNav";
import { Panel } from "@/components/ui/panel";
import { StatGrid } from "@/components/ui/stat";
import {
  OPEN_GATE_USD,
  TOPUP_STEP_USD,
  BUYBACK_FLOOR_USD,
  fmtThreshold,
} from "@/lib/config";
import { DOPPLER, LAUNCH_ROUTER, V4_POOL_MANAGER, explorerAddr } from "@/lib/clientConfig";
import { SNIPE, FEE_PRESETS, HOOK_FLUSH_EPSILON_USDG } from "@/lib/doppler";

export const metadata = { title: "Docs" };

/**
 * Protocol docs: how the engine works, what the contracts guarantee, what stays
 * the operator's responsibility.
 * Layout: sticky left sidebar with scrollspy, content on the right.
 */

const GROUPS: DocsGroup[] = [
  {
    label: "overview",
    items: [
      { id: "engine", title: "The engine" },
      { id: "glance", title: "At a glance" },
    ],
  },
  {
    label: "the coin",
    items: [
      { id: "launch", title: "Launch" },
      { id: "fees", title: "Fees, always in USDG" },
      { id: "protection", title: "Launch protection" },
      { id: "contracts", title: "Contract guarantees" },
      { id: "subwallets", title: "Fee destinations" },
    ],
  },
  {
    label: "the perp engine",
    items: [
      { id: "markets", title: "Market universe" },
      { id: "keeper", title: "The keeper loop" },
      { id: "lifecycle", title: "Position lifecycle" },
      { id: "tranches", title: "Tranches & take-profit" },
      { id: "profits", title: "Profits, buybacks, burns" },
    ],
  },
  {
    label: "protocol",
    items: [
      { id: "economics", title: "Economics" },
      { id: "verify", title: "What you can verify" },
      { id: "promises", title: "What we don't promise" },
    ],
  },
];

const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
  <section id={id} className="scroll-mt-24 border-t border-line pt-9 first:border-t-0 first:pt-0">
    <h2 className="text-2xl font-semibold">{title}</h2>
    <div className="mt-4 space-y-4 text-base leading-[1.65] text-ink-2">{children}</div>
  </section>
);

const K = ({ children }: { children: React.ReactNode }) => <span className="font-semibold text-ink">{children}</span>;
const N = ({ children }: { children: React.ReactNode }) => <span className="num text-ink">{children}</span>;
const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="num underline underline-offset-2 hover:text-ink">
    {children}
  </a>
);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const FEE_RANGE = `${FEE_PRESETS[0].label} to ${FEE_PRESETS[FEE_PRESETS.length - 1].label}`;

const PARAMS = [
  { label: "supply", value: "1B fixed" },
  { label: "opening mcap", value: "~$4,000" },
  { label: "trading fee", value: `${FEE_RANGE}, creator's choice` },
  { label: "fee currency", value: "USDG, always" },
  { label: "protocol fee", value: "5% of the fee, to Doppler" },
  { label: "launch protection", value: `${SNIPE.startFee / 10_000}% → fee in ${SNIPE.seconds}s, opt-in` },
  { label: "perp opens at", value: fmtThreshold(OPEN_GATE_USD) },
  { label: "top-up step", value: fmtThreshold(TOPUP_STEP_USD) },
  { label: "leverage", value: "2–20x isolated" },
  { label: "take profit", value: "+20/50/100%" },
  { label: "profit split", value: "75% burn · 25% treasury" },
  { label: "keeper tick", value: "15s" },
];

export default function DocsPage() {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] gap-10 px-4 pt-10 pb-8">
      {/* sidebar: solo desktop; su mobile c'e' l'indice in testa */}
      <aside className="sticky top-20 hidden h-fit w-[200px] shrink-0 self-start lg:block">
        <DocsNav groups={GROUPS} />
        <a
          href="/whitepaper.pdf"
          target="_blank"
          rel="noreferrer"
          className="mt-6 block border-t border-line pt-4 text-sm text-ink-3 transition-colors hover:text-ink"
        >
          whitepaper.pdf ↗
        </a>
      </aside>

      <div className="min-w-0 max-w-[720px] flex-1">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-ink-3">Protocol docs · v2</span>
          <a
            href="/whitepaper.pdf"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-ink-3 transition-colors hover:text-ink lg:hidden"
          >
            whitepaper.pdf ↗
          </a>
        </div>
        <h1 className="text-5xl font-bold leading-[1.12]">
          Coins backed by a <span className="text-brand">perp treasury</span>.
        </h1>
        <p className="mt-5 text-lg leading-[1.65] text-ink-2">
          multiply.cash launches coins whose trading fees fund a leveraged perpetual
          position on Lighter: BTC, stocks, even pre-IPO markets. Profits flow back
          on-chain and burn supply. The market is a Uniswap v4 pool built by Doppler,
          locked from the first block, with no owner and no admin key.
        </p>

        {/* indice mobile */}
        <Panel className="mt-7 px-5 py-4 lg:hidden">
          <div className="mb-3 text-sm font-semibold text-ink">Contents</div>
          <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
            {GROUPS.flatMap((g) => g.items).map((s) => (
              <a key={s.id} href={`#${s.id}`} className="text-md text-ink-2 transition-colors hover:text-ink">
                {s.title}
              </a>
            ))}
          </div>
        </Panel>

        <div className="mt-10 space-y-10">
          <Section id="engine" title="The engine">
            <p>
              Every coin starts the same way: fixed 1B supply, no owner, all of it seeded
              one-sided into a Uniswap v4 pool at ~$4k market cap, paired with USDG. The
              pool is created and locked by Doppler&apos;s contracts in the same
              transaction as the token. There is no bonding curve and no graduation: the
              pool seeded at launch is the coin&apos;s market for life.
            </p>
            <div className="overflow-x-auto rounded-[14px] bg-panel-2 p-5">
              <pre className="num text-xs leading-[1.7] text-ink-2">{`swap (fee ${FEE_RANGE}, taken by the pool's hook)
  ├─ buys pay it in the coin  → swapped to USDG inside the same swap
  └─ sells pay it in USDG     → passed straight through
        └─ 5% to Doppler · 95% to the coin's fee destination, in USDG
              └─ deposits to Lighter at the ${fmtThreshold(OPEN_GATE_USD)} gate
                 opens/tops-up the position chosen at launch
                 (market · direction · leverage · risk profile)

realized profit → withdrawn on-chain
  ├─ 75% buys the coin from the pool and burns it
  └─ 25% protocol treasury (the only protocol revenue)`}</pre>
            </div>
            <p>
              That circuit is the whole product. Fees are not income to be distributed.
              They are working capital, and they arrive as working capital: always in
              USDG, never as coins to be sold later. Every swap on the coin makes its
              position bigger; every take-profit on the position makes the coin scarcer.
            </p>
          </Section>

          <Section id="glance" title="At a glance">
            <StatGrid cols={3} className="grid-cols-2">
              {PARAMS.map((p) => (
                <div key={p.label} className="bg-card px-5 py-4">
                  <div className="mb-1 text-xs text-ink-3 first-letter:uppercase">{p.label}</div>
                  <div className="num text-md font-semibold text-ink">{p.value}</div>
                </div>
              ))}
            </StatGrid>
            <p>
              Every number above is a protocol parameter, not a promise: each one is
              enforced either by the contracts or by the keeper&apos;s public, on-chain
              behaviour, and each is covered in detail below.
            </p>
          </Section>

          <Section id="launch" title="Launch">
            <p>
              <K>One transaction, from your wallet.</K> A launch is a call to the
              multiply router (<A href={explorerAddr(LAUNCH_ROUTER)}>{short(LAUNCH_ROUTER)}</A>),
              which builds the whole market on Doppler&apos;s Airlock: the token, the pool,
              the lock and the fee hook, with the shape every multiply coin shares. The
              router holds no funds and never touches a coin after its launch.
            </p>
            <p>
              <K>The token.</K> A Doppler ERC-20 with fixed <N>1,000,000,000</N> supply,
              minted once. No mint function, no transfer tax, no pause, no blacklist. Its
              owner is the Airlock contract, which has no function to use that power.
              Burning is first-class: <N>burn()</N> reduces <N>totalSupply</N>.
            </p>
            <p>
              <K>The pool.</K> The entire supply goes into a Uniswap v4 pool against USDG
              as a single one-sided position: an ask ladder starting at roughly{" "}
              <N>$4,000</N> market cap. Every coin opens at the same valuation, whatever
              market or leverage it picked. Buys and sells are ordinary v4 swaps,
              routable by anything that speaks Uniswap. multiply.cash never custodies
              user balances.
            </p>
            <p>
              <K>The metadata.</K> Name, ticker, the coin&apos;s seal and the engine
              settings (market, direction, leverage, risk profile) are pinned to IPFS and
              written into the token, signed by the launching wallet. Terminals and
              explorers read the logo from there; the keeper reads the engine settings.
            </p>
            <p>
              <K>The first buy.</K> Optionally, a first buy in USDG is bundled into the
              launch through Doppler&apos;s Bundler: it is the pool&apos;s first swap by
              construction, so nobody can trade before the creator. The trading fee is
              waived on it except Doppler&apos;s slice.
            </p>
          </Section>

          <Section id="fees" title="Fees, always in USDG">
            <p>
              <K>The creator chooses the fee</K>, from {FEE_RANGE}, at launch. It is charged
              on every swap in both directions for the life of the pool, and it is
              immutable: no contract in the chain has a function to change it afterwards.
              A higher fee fuels the position faster and slows trading down.
            </p>
            <p>
              <K>Where it is taken.</K> The pool&apos;s LP fee is zero. The fee is taken by
              Doppler&apos;s Rehype hook (<A href={explorerAddr(DOPPLER.rehype)}>{short(DOPPLER.rehype)}</A>)
              on the output of each swap: a buy pays it in the coin, a sell pays it in
              USDG. The hook then swaps the coin-side fee into USDG inside the same call,
              so what leaves the pool is USDG only. No keeper, no operator, no inventory
              of coins waiting to be sold.
            </p>
            <p>
              <K>Where it goes.</K> Doppler keeps <N>5%</N> of every fee, its protocol
              fee for the launch stack. The remaining <N>95%</N> is transferred to the
              coin&apos;s fee destination in USDG. Two mechanical details: USDG fees below{" "}
              <N>{HOOK_FLUSH_EPSILON_USDG} USDG</N> wait on the hook until the next swap
              pushes them over, so small sells arrive in batches; and because the coin-side
              fee is sold back into the pool, every buy carries a small sell of its own fee.
            </p>
            <p>
              <K>Uniswap&apos;s protocol fee.</K> Uniswap v4&apos;s fee switch is active on
              Robinhood Chain. Its policy classifies pools by hook; pools with
              Doppler&apos;s hook are currently assessed at zero. If Uniswap ever assigns
              them a fee (at most 0.1% per swap), it is additive and paid by the trader;
              the engine&apos;s share does not change.
            </p>
          </Section>

          <Section id="protection" title="Launch protection">
            <p>
              Off by default. When the creator turns it on, the fee itself opens high and
              decays: <N>{SNIPE.startFee / 10_000}%</N> of the tokens bought at second
              zero, falling linearly to the coin&apos;s fee by second{" "}
              <N>{SNIPE.seconds}</N>, where it stays. A bot buying the launch block keeps
              little; a person buying a minute later pays the normal fee. The protection
              fee goes exactly where the normal fee goes.
            </p>
            <p>
              With protection on, the bundled first buy still pays Doppler&apos;s slice of
              the opening rate: 5% of {SNIPE.startFee / 10_000}%, that is 4% of the tokens
              it receives. With protection off that drops to 5% of the flat fee.
            </p>
          </Section>

          <Section id="contracts" title="Contract guarantees">
            <p>
              The market is made of Doppler&apos;s audited contracts on Robinhood Chain;
              multiply adds one router in front of them. What each guarantees:
            </p>
            <p>
              <K>DopplerHookInitializer</K> (<A href={explorerAddr(DOPPLER.hookInitializer)}>{short(DOPPLER.hookInitializer)}</A>).
              The v4 hook of every pool, and the owner of its liquidity. A pool created
              with fee beneficiaries is <N>Locked</N>: no exit, no withdraw, no migration.
              The only functions that could alter a live pool are gated on the
              token&apos;s governance timelock, and every multiply coin is launched with
              the no-op governance, whose timelock is the burn address. Nobody can call
              them.
            </p>
            <p>
              <K>Rehype hook</K> (<A href={explorerAddr(DOPPLER.rehype)}>{short(DOPPLER.rehype)}</A>).
              Takes the fee, converts it, forwards it. Its schedule (flat or decaying) is
              written once at launch.
            </p>
            <p>
              <K>Launch router</K> (<A href={explorerAddr(LAUNCH_ROUTER)}>{short(LAUNCH_ROUTER)}</A>).
              Enforces the shape of every launch: supply, opening market cap, fee range,
              protection schedule, fee destination, Doppler&apos;s 5%. It is upgradeable so
              its address can stay stable for indexers; an upgrade can only change{" "}
              <em>future</em> launches, because the router has no function that reaches a
              pool once it exists.
            </p>
            <p>
              A rug in the ordinary sense (someone withdraws the pool and walks) is not a
              thing that can happen here. Not for the creator, not for multiply.cash, not
              for Doppler. There is no LP token to unstake and no timelock that eventually
              opens.
            </p>
          </Section>

          <Section id="subwallets" title="Fee destinations">
            <p>
              <K>One wallet per coin.</K> Each coin&apos;s fees end up in an address of
              their own, the coin&apos;s sub-wallet, which is also the owner of the
              coin&apos;s Lighter account. Funds for one coin can never touch another
              coin&apos;s position, and every sub-wallet is public on the explorer.
            </p>
            <p>
              <K>Adoption.</K> At launch the fees are routed to the engine hub, a single
              public address; the keeper then re-points the coin&apos;s share to its own
              sub-wallet with a beneficiary update the contracts allow only from the
              current beneficiary. The coin&apos;s page shows where its fees are going at
              any time.
            </p>
            <p>
              <K>Who holds the keys.</K> Sub-wallet keys are derived deterministically
              from a single master secret, an HMAC-SHA256 over the token&apos;s address,
              so they exist only inside the keeper process. Never stored in a database,
              never handed to a browser, never shown to the person who launched the coin.
            </p>
            <p>
              <K>Why nobody can drain the position.</K> Each coin&apos;s Lighter account is
              opened under its own sub-wallet, and Lighter only accepts orders signed by
              the account&apos;s key. A creator cannot drain, close, or borrow against the
              position backing their coin, and neither can the creator of any other coin.
              The backing is operated by the keeper on a fixed policy, in public, or not at
              all.
            </p>
          </Section>

          <Section id="markets" title="Market universe">
            <p>
              The menu is Lighter&apos;s, not ours: any perp listed on Lighter&apos;s
              Robinhood deployment can back a coin: crypto majors, US stocks, pre-IPO
              names. The catalog is re-synced from the venue as markets are listed,
              roughly <N>39 markets</N> today.
            </p>
            <p>
              At launch the creator picks the market, the side (long or short) and the
              leverage: <N>2x, 3x, 5x, 10x or 20x</N>. Positions run{" "}
              <K>isolated margin</K>: a coin&apos;s position can only ever lose the
              collateral it has posted, never more. Higher leverage means faster burns on
              a good call, faster liquidation on a bad one.
            </p>
          </Section>

          <Section id="keeper" title="The keeper loop">
            <p>
              A keeper bot ticks every <N>15 seconds</N>. For every coin, each tick, in
              order:
            </p>
            <ul className="space-y-2">
              {[
                <>credits any perp withdrawal that landed since the last tick, bridge
                  settlements are recognized from the on-chain transfer itself and split
                  25% treasury / 75% buyback;</>,
                <>reads the USDG the pool&apos;s hook has forwarded since the last tick
                  and moves it into the perp reserve; any coins that reach the sub-wallet
                  (bought back, or sent by holders) are burned, entirely, every tick;</>,
                <>runs the buyback when the reserve clears <N>{fmtThreshold(BUYBACK_FLOOR_USD)}</N>;</>,
                <>marks the perp to market and decides: deposit, top up, or take
                  profit.</>,
              ].map((item, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p>
              <K>Crash safety.</K> Every bucket is checkpointed before the transaction is
              sent, so a crash at any point under-pays for one tick instead of paying
              twice. An ambiguous outcome, sent but unconfirmed, becomes a pending
              record and is reconciled against on-chain evidence; it is never blindly
              re-sent.
            </p>
          </Section>

          <Section id="lifecycle" title="Position lifecycle">
            <p>
              <K>Open at {fmtThreshold(OPEN_GATE_USD)}.</K> Once <N>{fmtThreshold(OPEN_GATE_USD)}</N> of fees have accrued, the keeper
              deposits into the coin&apos;s Lighter account and opens the position at the
              chosen market, side and leverage. Deposits travel as plain USDG transfers to
              a deterministic intent address; Lighter credits the coin&apos;s own account
              across the bridge.
            </p>
            <p>
              <K>Top up every {fmtThreshold(TOPUP_STEP_USD)}.</K> Every further <N>{fmtThreshold(TOPUP_STEP_USD)}</N> of fees is deposited and
              put to work at the same leverage, as a market order with a <N>2%</N>{" "}
              slippage cap.
            </p>
            <p>
              <K>Losses.</K> If price moves against the position, nothing closes at a loss
              and nothing averages down. Underwater tranches simply wait. New fees still
              open new tranches at the current mark. Each runs at its own target from
              where it entered.
            </p>
            <p>
              <K>Liquidation.</K> If the venue liquidates the position, the posted
              collateral is gone and the tranche book zeroes out. That is the whole blast
              radius: the pool, the locked liquidity and holder balances are untouched,
              and the engine restarts from the next {fmtThreshold(OPEN_GATE_USD)} of fees.
            </p>
          </Section>

          <Section id="tranches" title="Tranches. Every dollar has its own target">
            <p>
              The position on Lighter is one netted position, but the engine tracks every
              deposit as a <K>tranche</K> with its own entry price. A tranche takes profit
              when the underlying moves <N>trigger ÷ leverage</N> from <em>its</em> entry:
              which is exactly <N>+trigger</N> on that tranche&apos;s own collateral.
              New fees never dilute an old tranche&apos;s progress. The trigger is the
              coin&apos;s risk profile, fixed at launch:
            </p>
            <StatGrid cols={3} className="grid-cols-1">
              {[
                { k: "Safe", t: "+20%", d: "banks early, banks often" },
                { k: "Balanced", t: "+50%", d: "the middle path" },
                { k: "Degen", t: "+100%", d: "maximum conviction" },
              ].map((p) => (
                <div key={p.k} className="bg-card px-5 py-4">
                  <div className="text-sm font-semibold text-brand">{p.k}</div>
                  <div className="num mt-1 text-lg font-semibold text-ink">{p.t} per tranche</div>
                  <div className="mt-1 text-xs text-ink-3">{p.d}</div>
                </div>
              ))}
            </StatGrid>
            <p>
              Concretely: a 5x <K>safe</K> coin banks each tranche on a 4% move of the
              underlying; a 2x <K>degen</K> coin demands 50%.
            </p>
            <p>
              <K>Banking a tranche.</K> When a tranche matures, the keeper closes exactly
              that tranche&apos;s size: reduce-only, at market, fill-verified: the
              position is re-read after the order and profit is credited only for what
              actually closed. Freed collateral re-enters as a fresh tranche at the
              current mark, so banked capital keeps compounding.
            </p>
            <p>
              <K>Ring-fencing.</K> Realized profit is excluded from what the keeper can
              redeploy. Profit destined for burns can never be re-risked on the position
              it came from. It can only leave toward the buyback.
            </p>
            <p>
              <K>The venue is the truth.</K> The tranche book only ever converges toward
              what Lighter reports: position gone means the book zeroes; smaller than the
              book means tranches rescale pro-rata; larger means the excess becomes a
              synthetic tranche at the current entry.
            </p>
          </Section>

          <Section id="profits" title="Profits, buybacks, burns">
            <p>
              <K>Coming home.</K> Once realized profit clears <N>{fmtThreshold(BUYBACK_FLOOR_USD)}</N>, it&apos;s
              withdrawn from Lighter over the zk bridge (~15 minutes) back to the
              coin&apos;s sub-wallet, where it splits <K>25% protocol treasury / 75%
              buyback reserve</K>.
            </p>
            <p>
              <K>The buyback.</K> When a coin&apos;s buyback reserve crosses <N>{fmtThreshold(BUYBACK_FLOOR_USD)}</N>,
              the keeper buys the coin on its own pool and burns what it bought with the
              token&apos;s <N>burn()</N>. A single tick spends at most <N>{fmtThreshold(BUYBACK_FLOOR_USD)}</N>, with a
              minimum-out quoted from the live pool price minus 3%: a large reserve drains
              as a series of ordinary buys rather than one block-moving order.
            </p>
            <p>
              <K>One number.</K> Buybacks, plus any holder who sends to 0xdEaD on their
              own, show up in <N>initial supply − totalSupply</N>, the burn figure every
              page of this site reports. Trading fees themselves are not burned: they are
              turned into USDG and put to work, which is what makes the buyback bigger.
            </p>
          </Section>

          <Section id="economics" title="Economics">
            <p>
              Full degen split: <K>every trading fee funds the perp treasury</K>, in USDG.
              No creator cut, no fee skim beyond Doppler&apos;s 5% for the market
              infrastructure. The protocol earns only when the engine wins: 25% of
              realized profits, with the other 75% buying and burning supply. If the
              position never profits, the protocol earns nothing, incentives point the
              same way as holders&apos;. No launch fee either, beyond gas.
            </p>
            <p>
              Worst case is bounded by design: isolated margin means a liquidation costs
              the treasury&apos;s allocated collateral, never more. The engine then starts
              re-accumulating from the next fee.
            </p>
            <p>
              One honest caveat on exposure: the coin&apos;s spot price does not
              mechanically track its underlying. Exposure reaches holders as{" "}
              <K>realized flows</K>: take-profits that become buybacks and burns, not as
              a continuously repricing reserve. That looseness is what keeps a liquidation
              from ever touching the pool.
            </p>
          </Section>

          <Section id="verify" title="What you can verify">
            <p>
              Every launch, fee, burn, deposit and buyback is a confirmed transaction on
              Robinhood Chain. Each coin&apos;s page links its addresses out to the
              explorer: the token, the pool on the v4 PoolManager (<A href={explorerAddr(V4_POOL_MANAGER)}>{short(V4_POOL_MANAGER)}</A>),
              the hook that locks it, the fee hook, the fee destination, the router, the
              live Lighter account.
            </p>
            <p>
              The accounting closes: USDG into a sub-wallet matches the hook&apos;s fee
              transfers plus perp withdrawals; USDG out matches Lighter deposits and
              buyback swaps, which match on-chain burns and venue position deltas.
            </p>
            <p>
              <K>Don&apos;t trust this page.</K> Open the explorer and confirm the numbers
              match.
            </p>
          </Section>

          <Section id="promises" title="What we don't promise">
            <p>
              The keeper is a live dependency: if it stops, deposits, take-profits and
              buybacks pause; fees keep arriving in USDG at the fee destination, because
              the hook does that without us. The perp leg carries real market risk:
              leverage cuts both ways, and a coin&apos;s treasury can be liquidated. The
              master secret that derives sub-wallets is held by the operator: it cannot
              rug the liquidity (the lock makes that impossible) but it does control the
              flow of collected fees. Doppler&apos;s contracts are audited but not by us;
              Lighter, its zk bridge and RPC providers are all moving parts: an outage on
              any of them pauses deposits, take-profits or withdrawals until it recovers.
            </p>
            <p>
              Read the contracts, check the addresses, verify the burns. Then pick a
              market, a side, a leverage, and a coin you actually believe in.
            </p>
          </Section>
        </div>

        <div className="mt-14 border-t border-line pt-5 text-sm text-ink-3">
          Uniswap v4 · Doppler · Lighter · Robinhood Chain, verify everything
        </div>
      </div>
    </div>
  );
}
