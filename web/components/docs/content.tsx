import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { OPEN_GATE_USD, TOPUP_STEP_USD, BUYBACK_FLOOR_USD, fmtThreshold } from "@/lib/config";
import { BUYBACK_MAX_USD, FIRST_OPEN_DELAY_MIN, TRANCHE_INTERVAL_MIN, fmtEvery } from "@/lib/thresholds";
import { DOPPLER, LAUNCH_ROUTER, V4_POOL_MANAGER, explorerAddr } from "@/lib/clientConfig";
import { FLYWHEEL, SNIPE, FEE_PRESETS, HOOK_FLUSH_EPSILON_USDG, FEE_SPLIT_PCT, PROFIT_SPLIT_PCT, MAX_BUY_ORDERS, fmtSeconds } from "@/lib/doppler";

/**
 * The docs, as data: every page's title, one-line lede and body, grouped the
 * way the sidebar shows them. /docs is the index, /docs/[slug] renders one
 * page; both read from here so the order, the numbering and the prev/next
 * links can never drift apart.
 */

export type DocPage = { slug: string; title: string; lede: string; group: string; n: number; body: () => React.ReactNode };

const K = ({ children }: { children: React.ReactNode }) => <span className="font-semibold text-ink">{children}</span>;
const N = ({ children }: { children: React.ReactNode }) => <span className="num text-ink">{children}</span>;
const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="num underline underline-offset-2 hover:text-ink">
    {children}
  </a>
);
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const FEE_RANGE = `${FEE_PRESETS[0].label} to ${FEE_PRESETS[FEE_PRESETS.length - 1].label}`;

export const CONTRACTS = [
  { name: "Launch router", addr: LAUNCH_ROUTER },
  { name: "Doppler hook initializer", addr: DOPPLER.hookInitializer },
  { name: "Rehype fee hook", addr: DOPPLER.rehype },
  { name: "Uniswap v4 PoolManager", addr: V4_POOL_MANAGER },
];

function EngineBody() {
  return (
    <>
                  <p>
                    Every token starts the same way: fixed 1B supply, no owner, all of it seeded
                    one-sided into a Uniswap v4 pool at ~$4k market cap, paired with USDG. The
                    pool is created and locked by Doppler&apos;s contracts in the same
                    transaction as the token. There is no bonding curve and no graduation: the
                    pool seeded at launch is the token&apos;s market for life.
                  </p>
                  <div className="overflow-x-auto rounded-[18px] bg-night p-5 sm:p-6">
                    <div className="mb-3 text-xs font-medium tracking-wide text-mint">The circuit</div>
                    <pre className="num text-xs leading-[1.75] text-night-ink-2">{`swap (fee ${FEE_RANGE}, taken by the pool's hook)
        ├─ buys pay it in the token  → swapped to USDG inside the same swap
        └─ sells pay it in USDG     → passed straight through
              └─ ${FEE_SPLIT_PCT.doppler}% to Doppler · the rest to the token's own fee sink, in USDG
                    ├─ ${FEE_SPLIT_PCT.treasury}% protocol treasury
                    └─ ${FEE_SPLIT_PCT.engine}% the token's sub-wallet
                          └─ deposits to Lighter at the ${fmtThreshold(OPEN_GATE_USD)} gate
                             opens/tops-up the position the engine says
                             (market · direction · leverage · take-profit)

      take-profit → capital and gain withdrawn on-chain
        ├─ all the capital, ${PROFIT_SPLIT_PCT.buyback}% of the gain: buys the token and burns it
        └─ ${PROFIT_SPLIT_PCT.treasury}% of the gain: protocol treasury`}</pre>
                  </div>
                  <p>
                    That circuit is the whole product. Fees are not income to be distributed.
                    They are working capital, and they arrive as working capital: always in
                    USDG, never as tokens to be sold later. Every swap on the token makes its
                    position bigger; every take-profit on the position makes the token scarcer.
                  </p>
    </>
  );
}

function LaunchBody() {
  return (
    <>
      <p>
        <K>One transaction, from your wallet.</K> A launch is a call to the
        multiply router (<A href={explorerAddr(LAUNCH_ROUTER)}>{short(LAUNCH_ROUTER)}</A>),
        which builds the whole market on Doppler&apos;s Airlock: the token, the pool,
        the lock and the fee hook, with the shape every multiply token shares. The
        router holds no funds and has no function that reaches a token or its pool after launch.
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
        <N>$4,000</N> market cap. Every token opens at the same valuation, whatever
        market or leverage it picked. Buys and sells are ordinary v4 swaps,
        routable by anything that speaks Uniswap. multiply.cash never custodies
        user balances.
      </p>
      <p>
        <K>The metadata.</K> Name, ticker, the token&apos;s seal and the engine
        settings (market, direction, leverage, take-profit) are pinned to IPFS and
        written into the token, signed by the launching wallet. Terminals and
        explorers read the logo from there. The engine settings are on the router itself.
      </p>
      <p>
        <K>The first buy.</K> Optionally, a first buy in USDG is bundled into the
        launch through Doppler&apos;s Bundler: it is the pool&apos;s first swap by
        construction, so nobody can trade before the creator. The trading fee is
        waived on it except Doppler&apos;s slice. The creator can have part of it
        delivered to up to <N>{MAX_BUY_ORDERS}</N> other wallets: the creator pays
        for all of it, it is still one swap, and every wallet gets the same average
        price. The wallets and their amounts are public in the launch transaction.
      </p>
    </>
  );
}

function FeesBody() {
  return (
    <>
      <p>
        <K>The creator chooses the fee</K>, from {FEE_RANGE}, at launch. It is charged
        on every swap in both directions for the life of the pool, and it is
        immutable: no contract in the chain has a function to change it afterwards.
        A higher fee fuels the position faster and slows trading down.
      </p>
      <p>
        <K>Where it is taken.</K> The pool&apos;s LP fee is zero. The fee is taken by
        Doppler&apos;s Rehype hook (<A href={explorerAddr(DOPPLER.rehype)}>{short(DOPPLER.rehype)}</A>)
        on the output of each swap: a buy pays it in the token, a sell pays it in
        USDG. The hook then swaps the token-side fee into USDG inside the same call,
        so what leaves the pool is USDG only. No keeper, no operator, no inventory
        of tokens waiting to be sold.
      </p>
      <p>
        <K>Where it goes.</K> Doppler keeps <N>{FEE_SPLIT_PCT.doppler}%</N> of every fee, its
        protocol fee for the launch stack. The remaining <N>95%</N> is transferred in
        USDG to the token&apos;s fee sink, a small contract created in the launch
        transaction for that token alone. Its <N>flush()</N> is public and does one
        thing: <N>{FEE_SPLIT_PCT.treasury}%</N> of the trading fee to the protocol
        treasury, <N>{FEE_SPLIT_PCT.engine}%</N> to the token&apos;s sub-wallet, and any
        tokens that ever reached it burned. The split is written into the sink at launch
        and cannot change for that token; tokens launched before 25 November 2026 carry
        80% engine, 15% protocol. Two mechanical details: USDG fees below{" "}
        <N>{HOOK_FLUSH_EPSILON_USDG} USDG</N> wait on the hook until the next swap
        pushes them over, so small sells arrive in batches; and because the token-side
        fee is sold back into the pool, every buy carries a small sell of its own fee.
      </p>
      <p>
        <K>Uniswap&apos;s protocol fee.</K> Uniswap v4&apos;s fee switch is active on
        Robinhood Chain. Its policy classifies pools by hook; pools with
        Doppler&apos;s hook are currently assessed at zero. If Uniswap ever assigns
        them a fee (at most 0.1% per swap), it is additive and paid by the trader;
        the engine&apos;s share does not change.
      </p>
    </>
  );
}

function ProtectionBody() {
  return (
    <>
      <p>
        The fee itself opens high and decays. The creator picks the opening rate, up
        to <N>{SNIPE.maxFee / 10_000}%</N>, and how long it takes to fall in a
        straight line to the token&apos;s fee: <N>{fmtSeconds(SNIPE.defaultSeconds)}</N>{" "}
        unless changed, <N>{fmtSeconds(SNIPE.maxSeconds)}</N> at most, or off. Both
        are fixed at launch. A bot buying the launch block keeps little; a person
        buying after the window pays the normal fee. The hook charges the rate on
        what a swap receives; a swap asking for an exact number of tokens is charged
        it on what it pays instead, which at {SNIPE.maxFee / 10_000}% makes those
        tokens cost 1.8 times the price. Sells inside the window pay the
        same rate as buys. The protection fee goes exactly where the normal fee goes.
      </p>
      <p>
        With protection on, the bundled first buy still pays Doppler&apos;s slice of
        the opening rate: at {SNIPE.maxFee / 10_000}%, 4% of the tokens it receives. With protection off that drops to 5% of the flat fee.
      </p>
    </>
  );
}

function ContractsBody() {
  return (
    <>
      <p>
        The market is made of Doppler&apos;s audited contracts on Robinhood Chain;
        multiply adds one router in front of them. What each guarantees:
      </p>
      <p>
        <K>DopplerHookInitializer</K> (<A href={explorerAddr(DOPPLER.hookInitializer)}>{short(DOPPLER.hookInitializer)}</A>).
        The v4 hook of every pool, and the owner of its liquidity. A pool created
        with fee beneficiaries is <N>Locked</N>: no exit, no withdraw, no migration.
        The only functions that could alter a live pool are gated on the
        token&apos;s governance timelock, and every multiply token is launched with
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
        protection limits, fee destination, Doppler&apos;s 5%. It is upgradeable so
        its address can stay stable for indexers. No upgrade can reach a token, its pool or
        its lock: the router has no function that does, and they do not answer to it. What it
        does hold for running tokens is their engine settings and the treasury address.
      </p>
      <p>
        A rug in the ordinary sense (someone withdraws the pool and walks) is not a
        thing that can happen here. Not for the creator, not for multiply.cash, not
        for Doppler. There is no LP token to unstake and no timelock that eventually
        opens.
      </p>
    </>
  );
}

function FeeDestinationsBody() {
  return (
    <>
      <p>
        <K>One wallet per token.</K> Each token&apos;s fees end up in an address of
        their own, the token&apos;s sub-wallet, which is also the owner of the
        token&apos;s Lighter account. Funds for one token can never touch another
        token&apos;s position, and every sub-wallet is public on the explorer.
      </p>
      <p>
        <K>Adoption.</K> The hook fixes where a pool&apos;s fees go at initialization
        and has no setter, so the launch gives it the token&apos;s fee sink, cloned in
        the same transaction. The keeper then points the sink at the token&apos;s
        sub-wallet. After that first step the keeper key cannot move it: only the
        router&apos;s owner can, the recovery path for a sub-wallet that became
        unusable, and the sink exposes no way to touch the fee matrix the launch
        set. Until it is pointed, fees simply accumulate in the sink. The token&apos;s
        page shows its sink and where its fees are going at any time.
      </p>
      <p>
        <K>Who holds the keys.</K> Sub-wallet keys are derived deterministically
        from a single master secret, an HMAC-SHA256 over the token&apos;s address,
        so they exist only inside the keeper process. Never stored in a database,
        never handed to a browser, never shown to the person who launched the token.
      </p>
      <p>
        <K>Why nobody can drain the position.</K> Each token&apos;s Lighter account is
        opened under its own sub-wallet, and Lighter only accepts orders signed by
        the account&apos;s key. A creator cannot drain or borrow against the
        position backing their token, and neither can the creator of any other token. The most a managed
        token&apos;s creator can do is move its engine, announced ahead, which closes one position to open another.
        The backing is operated by the keeper on a fixed policy, in public, or not at
        all.
      </p>
    </>
  );
}

function MarketsBody() {
  return (
    <>
      <p>
        The menu is Lighter&apos;s, not ours: any perp listed on Lighter&apos;s
        Robinhood deployment can back a token: crypto majors, US stocks, pre-IPO
        names. The catalog is re-synced from the venue as markets are listed,
        more than <N>70 markets</N> today.
      </p>
      <p>
        At launch the creator picks the market, the side (long or short) and the
        leverage: <N>2x, 3x, 5x, 10x, 20x, 25x or 50x</N>, never above what Lighter allows
        on that market (50x on BTC, ETH, SPY and QQQ, 3x on the newest memecoins). If the
        venue later lowers a market&apos;s cap below a token&apos;s leverage, the keeper stops
        opening and says so on the token&apos;s page until the leverage fits again. Positions run{" "}
        <K>isolated margin</K>: a token&apos;s position can only ever lose the
        collateral it has posted, never more. Higher leverage means faster burns on
        a good call, faster liquidation on a bad one.
      </p>
    </>
  );
}

function KeeperBody() {
  return (
    <>
      <p>
        A keeper bot ticks every <N>15 seconds</N>. For every token, each tick, in
        order:
      </p>
      <ol className="space-y-3">
        {[
          <>credits any perp withdrawal that landed since the last tick, bridge
            settlements are recognized from the on-chain transfer itself: {PROFIT_SPLIT_PCT.treasury}% of
            the gain to the treasury, the rest to the buyback reserve;</>,
          <>flushes the token&apos;s fee sink when it holds enough to be worth the
            gas ({FEE_SPLIT_PCT.treasury}% to the treasury, {FEE_SPLIT_PCT.engine}% to
            the sub-wallet, tokens burned) and moves what arrived into the perp
            reserve; any tokens that reach the sub-wallet (bought back, or sent by
            holders) are burned, entirely, every tick;</>,
          <>runs the buyback when the reserve clears <N>{fmtThreshold(BUYBACK_FLOOR_USD)}</N>;</>,
          <>marks the perp to market and decides: deposit, top up, or take
            profit.</>,
        ].map((item, i) => (
          <li key={i} className="flex gap-4">
            <span className="num mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-brand text-xs font-semibold text-brand">
              {i + 1}
            </span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ol>
      <p>
        <K>Crash safety.</K> Every bucket is checkpointed before the transaction is
        sent, so a crash at any point under-pays for one tick instead of paying
        twice. An ambiguous outcome, sent but unconfirmed, becomes a pending
        record and is reconciled against on-chain evidence; it is never blindly
        re-sent.
      </p>
    </>
  );
}

function LifecycleBody() {
  return (
    <>
      <p>
        <K>Open at {fmtThreshold(OPEN_GATE_USD)}.</K> Once <N>{fmtThreshold(OPEN_GATE_USD)}</N> of fees have accrued, the keeper
        deposits into the token&apos;s Lighter account and opens the position at the
        chosen market, side and leverage. The first position waits <N>{FIRST_OPEN_DELAY_MIN} minutes</N> from the
        launch, so the fees of the opening go in together. After a take-profit a new one opens as soon as
        the gate is met again. Deposits travel as plain USDG transfers to
        a deterministic intent address; Lighter credits the token&apos;s own account
        across the bridge.
      </p>
      <p>
        <K>One tranche every {fmtEvery(TRANCHE_INTERVAL_MIN)}.</K> While the position is open, the fees that have
        accrued (at least <N>{fmtThreshold(TOPUP_STEP_USD)}</N>) are deposited together and
        put to work at the same leverage, as a market order with a <N>2%</N>{" "}
        slippage cap.
      </p>
      <p>
        <K>Losses.</K> If price moves against the position, the engine never closes at a loss
        on its own (only a managed token&apos;s creator moving it does) and nothing averages down. Underwater tranches simply wait. New fees still
        open new tranches at the current mark. Each runs at its own target from
        where it entered.
      </p>
      <p>
        <K>Where liquidation is.</K> Not at 100 ÷ leverage. Lighter closes a position while some
        margin is left, so that closing it cannot cost more than was posted: that maintenance margin is set per
        market (<N>1.2%</N> of the position on BTC, <N>3%</N> on NVDA, <N>6%</N> on ANT today). The distance is{" "}
        <N>100 ÷ leverage − maintenance margin</N>: BTC at 50x is liquidated <N>0.8%</N> away, at 25x <N>2.8%</N>, at
        10x <N>8.8%</N>. Near a market&apos;s maximum leverage most of the room is gone, and a small step down gives
        back a lot of it. Lighter also charges up to 1% on a liquidation, so little of the margin left comes back.
        The launch form shows the number for every leverage.
      </p>
      <p>
        <K>Liquidation.</K> If the venue liquidates the position, the posted
        collateral is gone and the tranche book zeroes out. That is the whole blast
        radius: the pool, the locked liquidity and holder balances are untouched,
        and the engine restarts from the next {fmtThreshold(OPEN_GATE_USD)} of fees.
      </p>
    </>
  );
}

function TranchesBody() {
  return (
    <>
      <p>
        The position on Lighter is one netted position, but the engine tracks every
        deposit as a <K>tranche</K> with its own entry price. A tranche takes profit
        when the underlying moves <N>trigger ÷ leverage</N> from <em>its</em> entry:
        which is exactly <N>+trigger</N> on that tranche&apos;s own collateral.
        New fees never dilute an old tranche&apos;s progress. The trigger is the
        token&apos;s take-profit, set at launch (and retunable on managed tokens) from <N>+10%</N> up to <N>20×</N> the leverage, so a
        target never needs more than a <N>20%</N> move of the asset: <N>+40%</N> at 2x, <N>+200%</N> at
        10x, the <N>+500%</N> ceiling from 25x up.
        The usual picks:
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { k: "Safe", t: "+20%", d: "banks early, banks often" },
          { k: "Balanced", t: "+50%", d: "the middle path" },
          { k: "Degen", t: "+100%", d: "about doubles each deposit" },
          { k: "Moon", t: "+300%", d: "rides for a multiple" },
        ].map((p) => (
          <div key={p.k} className="min-w-0 rounded-[14px] border border-border bg-card px-4 py-4">
            <div className="text-xs font-medium text-ink-3">{p.k}</div>
            <div className="num mt-1 text-3xl font-semibold tracking-[-0.02em] text-brand">{p.t}</div>
            <div className="mt-1.5 text-xs leading-snug text-ink-3">{p.d}</div>
          </div>
        ))}
      </div>
      <p>
        Concretely: a 5x token at +20% banks each tranche on a 4% move of the
        underlying; a 2x token at its +40% ceiling needs 20%.
      </p>
      <p>
        <K>Targets that come down with time.</K> A target far away can leave a deposit in
        profit but never banked. So a tranche that has not matured after{" "}
        <N>7 days</N> starts lowering its own target, in a straight line, down to{" "}
        <N>+10%</N> by day <N>30</N>. A tranche in profit therefore banks eventually; one
        underwater waits as before, and its worst case stays the liquidation of its own
        collateral.
      </p>
      <p>
        <K>Managed tokens.</K> At launch the creator chooses whether the engine is fixed
        or <K>managed</K>. A fixed token keeps its market and side for life. A managed
        token&apos;s creator can change all of it later: market, side, leverage and
        take-profit. Every change is announced on-chain by the router and takes effect after
        a notice (shown on the launch form and on every managed token&apos;s page), so holders can see it and decide; the token carries a
        Managed badge everywhere and its page lists every change. The notice is one setting for every
        token, kept by the router&apos;s owner, and moving it never moves a change already
        announced.
      </p>
      <p>
        <K>What a change of market or side does.</K> When it takes effect the keeper closes the
        whole position at market, reduce-only, and opens nothing until that close has filled. A net profit
        is banked like any other ({PROFIT_SPLIT_PCT.buyback}% buyback, {PROFIT_SPLIT_PCT.treasury}% protocol),
        net of what the close cost; a net loss is final. What is left is the collateral of the new position.
        If the market is closed or the book is empty, the keeper waits and tries again.
      </p>
      <p>
        <K>The owner&apos;s override.</K> Independently, the router&apos;s owner can override any
        token&apos;s leverage or take-profit immediately, fixed or managed, the escape hatch for a
        venue that lowers a cap; never its market or side. Every override is a public event.
      </p>
      <p>
        <K>Banking a tranche.</K> When a tranche matures, the keeper closes exactly
        that tranche&apos;s size: reduce-only, at market, fill-verified: the
        position is re-read after the order and only what actually closed is
        credited, at the price it filled at. The whole tranche leaves the engine:
        the capital that was in it and its gain. The next position is loaded by new fees.
      </p>
      <p>
        <K>Ring-fencing.</K> What a take-profit took out, capital and gain, is excluded
        from what the keeper can deploy. It can never be re-risked on the position
        it came from. It can only leave toward the buyback.
      </p>
      <p>
        <K>The venue is the truth.</K> The tranche book only ever converges toward
        what Lighter reports: position gone means the book zeroes; smaller than the
        book means tranches rescale pro-rata; larger means the excess becomes a
        synthetic tranche at the current entry.
      </p>
    </>
  );
}

function ProfitsBody() {
  return (
    <>
      <p>
        <K>Coming home.</K> Once what take-profits took out clears <N>{fmtThreshold(BUYBACK_FLOOR_USD)}</N>, it&apos;s
        withdrawn from Lighter over the zk bridge (~15 minutes) back to the
        token&apos;s sub-wallet. <K>All the capital and {PROFIT_SPLIT_PCT.buyback}% of the gain</K> go to the
        buyback reserve, {PROFIT_SPLIT_PCT.treasury}% of the gain to the protocol treasury.
      </p>
      <p>
        <K>The buyback.</K> When a token&apos;s buyback reserve crosses <N>{fmtThreshold(BUYBACK_FLOOR_USD)}</N>,
        the keeper buys the token on its own pool and burns what it bought with the
        token&apos;s <N>burn()</N>. A single tick spends at most <N>{fmtThreshold(BUYBACK_MAX_USD)}</N>, with a
        minimum-out quoted from the live pool price minus 3%: a large reserve drains
        as a series of ordinary buys rather than one block-moving order.
      </p>
      <p>
        <K>One number.</K> Buybacks, plus any holder who sends to 0xdEaD on their
        own, show up in <N>initial supply − totalSupply</N>, the burn figure every
        page of this site reports. Trading fees themselves are not burned: they are
        turned into USDG and put to work, which is what makes the buyback bigger.
      </p>
    </>
  );
}

function EconomicsBody() {
  return (
    <>
      <p>
        Of every trading fee, in USDG: <K>{FEE_SPLIT_PCT.engine}% funds the token&apos;s
        perp treasury</K>, {FEE_SPLIT_PCT.treasury}% goes to the protocol and{" "}
        {FEE_SPLIT_PCT.doppler}% to Doppler for the market infrastructure. No creator
        cut. The split is enforced by the token&apos;s fee sink, not by the keeper. On
        the way back the protocol takes {PROFIT_SPLIT_PCT.treasury}% of the gain; the
        other {PROFIT_SPLIT_PCT.buyback}% and all the capital buy and burn supply. No launch fee, beyond gas.
      </p>
      <p>
        <K>What the protocol does with its share.</K> {FLYWHEEL.buybackPct}% of everything it earns, from fees and from gains, buys{" "}
        <N>$MULTIPLY</N> on its own pool and burns it; {FLYWHEEL.treasuryPct}% stays in the treasury. The keeper looks every{" "}
        <N>{FLYWHEEL.everyMin} minutes</N>, buys from <N>${FLYWHEEL.minUsd}</N> up in a size that moves the price by {FLYWHEEL.impactPct}% at
        most, never while a launch protection is still high, and burns exactly what it bought. Every buyback is listed on{" "}
        <Link href="/burn" className="font-medium text-brand underline underline-offset-4">the burn page</Link>. It starts when $MULTIPLY launches.
      </p>
      <p>
        Worst case is bounded by design: isolated margin means a liquidation costs
        the treasury&apos;s allocated collateral, never more. The engine then starts
        re-accumulating from the next fee.
      </p>
      <p>
        One honest caveat on exposure: the token&apos;s spot price does not
        mechanically track its underlying. Exposure reaches holders as{" "}
        <K>realized flows</K>: take-profits that become buybacks and burns, not as
        a continuously repricing reserve. That looseness is what keeps a liquidation
        from ever touching the pool.
      </p>
    </>
  );
}

function VerifyBody() {
  return (
    <>
      <p>
        Every launch, fee, burn, deposit and buyback is a confirmed transaction on
        Robinhood Chain. Each token&apos;s page links its addresses out to the
        explorer: the token, the pool on the v4 PoolManager (<A href={explorerAddr(V4_POOL_MANAGER)}>{short(V4_POOL_MANAGER)}</A>),
        the hook that locks it, the fee hook, the fee destination, the router, the
        live Lighter account.
      </p>
      <p>
        The accounting closes: USDG into a sub-wallet matches the hook&apos;s fee
        transfers plus perp withdrawals; USDG out matches Lighter deposits and
        buyback swaps, which match on-chain burns and venue position deltas.
      </p>
      <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-border bg-card">
        {CONTRACTS.map((c) => (
          <li key={c.name}>
            <a
              href={explorerAddr(c.addr)}
              target="_blank"
              rel="noreferrer"
              className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-panel"
            >
              <span className="min-w-0 truncate text-sm font-medium text-ink">{c.name}</span>
              <span className="num inline-flex shrink-0 items-center gap-1 text-sm text-ink-3 group-hover:text-brand">
                {short(c.addr)} <ArrowUpRight size={13} aria-hidden />
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p>
        <K>Don&apos;t trust this page.</K> Open the explorer and confirm the numbers
        match.
      </p>
    </>
  );
}

function RisksBody() {
  return (
    <>
      <p>
        The keeper is a live dependency: if it stops, deposits, take-profits and
        buybacks pause; fees keep arriving in USDG at the fee destination, because
        the hook does that without us. The perp leg carries real market risk:
        leverage cuts both ways, and a token&apos;s treasury can be liquidated. The
        master secret that derives sub-wallets is held by the operator: it cannot
        rug the liquidity (the lock makes that impossible) but it does control the
        flow of collected fees. Doppler&apos;s contracts are audited but not by us;
        Lighter, its zk bridge and RPC providers are all moving parts: an outage on
        any of them pauses deposits, take-profits or withdrawals until it recovers.
      </p>
      <p>
        Read the contracts, check the addresses, verify the burns. Then pick a
        market, a side, a leverage, and a token you actually believe in.
      </p>
    </>
  );
}

const GROUPS: { label: string; pages: Omit<DocPage, "group" | "n">[] }[] = [
  {
    label: "Start here",
    pages: [
      { slug: "engine", title: "The engine", lede: "Fees in, a leveraged position out, burns back: the whole circuit.", body: EngineBody },
    ],
  },
  {
    label: "The token",
    pages: [
      { slug: "launch", title: "Launch", lede: "One transaction builds the token, the pool, the lock and the fee hook.", body: LaunchBody },
      { slug: "fees", title: "Fees, always in USDG", lede: "Chosen at launch, charged on every swap, delivered in USDG.", body: FeesBody },
      { slug: "protection", title: "Launch protection", lede: "A fee that opens high and decays over a window the creator picks.", body: ProtectionBody },
      { slug: "contracts", title: "Contract guarantees", lede: "What each contract guarantees, and why the pool cannot be pulled.", body: ContractsBody },
      { slug: "fee-destinations", title: "Fee destinations", lede: "Every token has a wallet of its own, and nobody can drain it.", body: FeeDestinationsBody },
    ],
  },
  {
    label: "The perp engine",
    pages: [
      { slug: "markets", title: "Market universe", lede: "Any perp Lighter lists, long or short, up to the market's cap.", body: MarketsBody },
      { slug: "keeper", title: "The keeper loop", lede: "Every 15 seconds, the same four steps for every token.", body: KeeperBody },
      { slug: "lifecycle", title: "Position lifecycle", lede: "From the first deposit to a liquidation, and what each one touches.", body: LifecycleBody },
      { slug: "tranches", title: "Tranches & take-profit", lede: "Every deposit runs toward a target of its own.", body: TranchesBody },
      { slug: "profits", title: "Profits, buybacks, burns", lede: "How a take-profit becomes a buyback and a burn.", body: ProfitsBody },
    ],
  },
  {
    label: "Protocol",
    pages: [
      { slug: "economics", title: "Economics", lede: "Who gets what, and a worst case bounded by design.", body: EconomicsBody },
      { slug: "verify", title: "What you can verify", lede: "Every contract, one click from the explorer.", body: VerifyBody },
      { slug: "risks", title: "What we don't promise", lede: "The moving parts, and what pauses when one of them stops.", body: RisksBody },
    ],
  },
];

export const DOC_PAGES: DocPage[] = GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.label }))).map(
  (p, i) => ({ ...p, n: i + 1 })
);
export const DOC_GROUPS = GROUPS.map((g) => ({ label: g.label, pages: DOC_PAGES.filter((p) => p.group === g.label) }));

/** The sidebar's view of the docs: plain data a client component can take. */
export const DOC_NAV = DOC_GROUPS.map((g) => ({ label: g.label, items: g.pages.map(({ slug, title }) => ({ slug, title })) }));
