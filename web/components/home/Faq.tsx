"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { FEE_SPLIT_PCT, PROFIT_SPLIT_PCT } from "@/lib/doppler";
import { OPEN_GATE_LABEL } from "@/lib/thresholds";

/**
 * The questions people actually ask before buying a coin like this, answered
 * from the docs and nothing beyond them. Each answer is short; the docs page is
 * where the long version lives.
 */
const QA: { q: string; a: React.ReactNode }[] = [
  {
    q: "Does it work with no volume?",
    a: (
      <p>
        Once it is loaded, yes. Trading fees fund the position, so a token needs some volume first; the position
        opens when {OPEN_GATE_LABEL} of fees have reached it. From there it follows the asset, and takes its profit
        and buys back, whether or not anyone is trading the token.
      </p>
    ),
  },
  {
    q: "What happens if the position gets liquidated?",
    a: (
      <p>
        It loses the fees it was holding, and nothing more: margin is isolated, so a loss cannot exceed the
        collateral. The pool, its locked liquidity and every holder&apos;s balance are untouched, and the next
        fees open a fresh position.
      </p>
    ),
  },
  {
    q: "Does a falling asset push the token down?",
    a: (
      <p>
        Not mechanically. The engine never sells the token: its only trade on the pool is the buyback. The
        token&apos;s price is set by the people trading it, and the asset&apos;s trend only ever reaches it as buys.
      </p>
    ),
  },
  {
    q: "Can the creator rug or take the fees?",
    a: (
      <p>
        No. Liquidity is locked by Doppler&apos;s contracts from the first block, with no LP token to withdraw.
        The creator gets no share of the fees and holds no key to the token&apos;s wallet or its Lighter account.
      </p>
    ),
  },
  {
    q: "Where exactly do the trading fees go?",
    a: (
      <p>
        {FEE_SPLIT_PCT.engine}% to the token&apos;s own wallet, which funds its position. {FEE_SPLIT_PCT.treasury}% to
        the protocol and {FEE_SPLIT_PCT.doppler}% to Doppler for the market infrastructure. All of it settles in
        USDG, never in tokens waiting to be sold.
      </p>
    ),
  },
  {
    q: "When does a buyback happen?",
    a: (
      <p>
        Every deposit is a tranche with its own target: the take-profit set at launch, from +10% up to 20 times the leverage (+500% at most) on
        its collateral. A deposit that has not banked after a week starts lowering its target, so profit never waits
        forever. When one matures it closes, and {PROFIT_SPLIT_PCT.buyback}% of the profit buys the token on its pool
        and burns it. The other {PROFIT_SPLIT_PCT.treasury}% goes to the protocol.
      </p>
    ),
  },
  {
    q: "Which assets can back a token?",
    a: (
      <p>
        Any perp listed on Lighter&apos;s Robinhood deployment: crypto majors, US stocks and indices, gold and
        silver, even pre-IPO names. Long or short, from 2x up to 50x where the venue allows it.
      </p>
    ),
  },
  {
    q: "Can a token change direction?",
    a: (
      <p>
        Only if it was launched as managed. Its creator can then move it to another market or flip it between long and
        short; every change is announced on-chain before it takes effect, and the token wears a Managed badge. A fixed
        token keeps its market and side for life.
      </p>
    ),
  },
];

export default function Faq() {
  return (
    <Accordion className="border-t border-line">
      {QA.map((item) => (
        <AccordionItem key={item.q} value={item.q} className="border-line">
          <AccordionTrigger>{item.q}</AccordionTrigger>
          <AccordionContent>{item.a}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
