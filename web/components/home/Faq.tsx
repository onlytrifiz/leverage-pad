"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { FEE_SPLIT_PCT } from "@/lib/doppler";

/**
 * The questions people actually ask before buying a coin like this, answered
 * from the docs and nothing beyond them. Each answer is short; the docs page is
 * where the long version lives.
 */
const QA: { q: string; a: React.ReactNode }[] = [
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
    q: "Does a falling asset push the coin down?",
    a: (
      <p>
        Not mechanically. The engine never sells the coin: its only trade on the pool is the buyback. The
        coin&apos;s price is set by the people trading it, and the asset&apos;s trend only ever reaches it as buys.
      </p>
    ),
  },
  {
    q: "Can the creator rug or take the fees?",
    a: (
      <p>
        No. Liquidity is locked by Doppler&apos;s contracts from the first block, with no LP token to withdraw.
        The creator gets no share of the fees and holds no key to the coin&apos;s wallet or its Lighter account.
      </p>
    ),
  },
  {
    q: "Where exactly do the trading fees go?",
    a: (
      <p>
        {FEE_SPLIT_PCT.engine}% to the coin&apos;s own wallet, which funds its position. {FEE_SPLIT_PCT.treasury}% to
        the protocol and {FEE_SPLIT_PCT.doppler}% to Doppler for the market infrastructure. All of it settles in
        USDG, never in coins waiting to be sold.
      </p>
    ),
  },
  {
    q: "When does a buyback happen?",
    a: (
      <p>
        Every deposit is a tranche with its own target: the take-profit set at launch, anywhere from +10% to +500% on
        its collateral. A deposit that has not banked after a week starts lowering its target, so profit never waits
        forever. When one matures it closes, and 75% of the profit buys the coin on its pool
        and burns it. The other 25% goes to the protocol.
      </p>
    ),
  },
  {
    q: "Which assets can back a coin?",
    a: (
      <p>
        Any perp listed on Lighter&apos;s Robinhood deployment: crypto majors, US stocks and indices, gold and
        silver, even pre-IPO names. Long or short, from 2x up to 50x where the venue allows it.
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
