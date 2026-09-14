const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  trancheTargetMark,
  markFromPosition,
  reconcileTranches,
  addTranche,
  matureTranches,
  removeClosedBase,
  realizedFromTranches,
  fundingDelta,
  quoteExactInV3,
  coinValueInQuote,
} = require('../keeper');

/**
 * Test a secco degli helper puri del keeper.
 *
 * Dove possibile i casi usano i NUMERI VERI delle sessioni live (TESTPLAN.md):
 * un test che riproduce un incidente accaduto vale piu' di dieci inventati, e
 * se un domani la formula cambia, qui salta il caso che e' costato denaro.
 *
 * Niente rete, niente chiavi, niente stato su disco: `npm test`.
 */

const near = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `atteso ~${b}, ottenuto ${a} (delta ${Math.abs(a - b)})`);

const tr = (base, entryMark, collateralUsd = 0, sizeDec = 4) => ({
  base, entryMark, collateralUsd, sizeDec, ts: 1_700_000_000_000,
});

// ── trancheTargetMark ────────────────────────────────────────────────────────
test('trancheTargetMark: il target e trigger/leva dall entry, nel verso del lato', async (t) => {
  await t.test('long sale, short scende', () => {
    near(trancheTargetMark(100, 'long', 2, 0.5), 125);
    near(trancheTargetMark(100, 'short', 2, 0.5), 75);
  });

  // ancore di regressione: target registrati on-chain nei test con denaro vero
  await t.test('TEST2 — NVDA long 3x degen', () => near(trancheTargetMark(225.23, 'long', 3, 1.0), 300.31, 0.01));
  await t.test('TEST3 — TSLA short 5x balanced', () => near(trancheTargetMark(341.61, 'short', 5, 0.5), 307.45, 0.01));
  await t.test('TEST4 — ETH long 10x safe', () => near(trancheTargetMark(1887.65, 'long', 10, 0.2), 1925.40, 0.01));
  await t.test('TEST5 — HYPE short 20x degen', () => near(trancheTargetMark(57.574, 'short', 20, 1.0), 54.70, 0.01));

  await t.test('piu leva = movimento richiesto minore', () => {
    const a = trancheTargetMark(100, 'long', 2, 1.0);
    const b = trancheTargetMark(100, 'long', 20, 1.0);
    assert.ok(b < a, 'a 20x il target deve essere piu vicino che a 2x');
  });
});

// ── markFromPosition ─────────────────────────────────────────────────────────
test('markFromPosition: mark implicito coerente col PnL del venue', async (t) => {
  await t.test('long in profitto', () => {
    near(markFromPosition({ size: '10', avg_entry_price: '100', unrealized_pnl: '50' }, 'long'), 105);
  });
  await t.test('short in profitto (il mark e SOTTO l entry)', () => {
    near(markFromPosition({ size: '-10', avg_entry_price: '100', unrealized_pnl: '50' }, 'short'), 95);
  });
  await t.test('size negativa gestita col valore assoluto', () => {
    near(markFromPosition({ size: '-10', avg_entry_price: '100', unrealized_pnl: '-50' }, 'short'), 105);
  });

  // input sporchi dall'API: meglio null che un mark inventato su cui poi si chiude
  for (const [nome, pos] of [
    ['size zero', { size: '0', avg_entry_price: '100', unrealized_pnl: '1' }],
    ['entry zero', { size: '10', avg_entry_price: '0', unrealized_pnl: '1' }],
    ['entry non numerico', { size: '10', avg_entry_price: 'n/d', unrealized_pnl: '1' }],
    ['pnl assente', { size: '10', avg_entry_price: '100', unrealized_pnl: undefined }],
  ]) {
    await t.test(`${nome} → null`, () => assert.equal(markFromPosition(pos, 'long'), null));
  }
});

// ── reconcileTranches ────────────────────────────────────────────────────────
test('reconcileTranches: il venue e la verita, la contabilita si adegua', async (t) => {
  await t.test('somma coincidente → nessun cambiamento', () => {
    const t0 = [tr(100, 10), tr(50, 12)];
    const r = reconcileTranches(t0, 150, 11, 4);
    assert.equal(r.changed, false);
    assert.equal(r.tranches, t0, 'deve restituire la stessa lista, non una copia');
  });

  await t.test('posizione sparita → tranche azzerate con nota', () => {
    const r = reconcileTranches([tr(100, 10)], 0, 11, 4);
    assert.deepEqual(r.tranches, []);
    assert.equal(r.changed, true);
    assert.match(r.note, /liquidata|sparita/);
  });

  await t.test('posizione gia sparita e libro gia vuoto → nessun rumore', () => {
    const r = reconcileTranches([], 0, 11, 4);
    assert.equal(r.changed, false);
    assert.equal(r.note, null);
  });

  await t.test('size on-chain maggiore → tranche sintetica per la differenza', () => {
    const r = reconcileTranches([tr(100, 10)], 130, 12, 4);
    assert.equal(r.tranches.length, 2);
    assert.equal(r.tranches[1].base, 30);
    assert.equal(r.tranches[1].entryMark, 12, 'la sintetica entra al mark corrente');
    assert.equal(r.tranches[1].synthetic, true);
  });

  await t.test('size on-chain minore → riscalatura pro-quota', () => {
    const r = reconcileTranches([tr(100, 10), tr(100, 20)], 150, 15, 4);
    assert.equal(r.tranches.reduce((a, x) => a + x.base, 0), 150);
    assert.equal(r.changed, true);
  });

  // l'invariante che conta: dopo la riconciliazione la somma DEVE fare esattamente
  // posBase, o il keeper prova a chiudere size che non esiste
  await t.test('invariante: la somma combacia sempre, anche con resti scomodi', () => {
    const casi = [
      [[tr(333, 10), tr(333, 11), tr(334, 12)], 777],
      [[tr(1, 10), tr(1, 11), tr(1, 12)], 2],
      [[tr(594, 57.5), tr(17, 55.7), tr(6, 55.9)], 601],
      [[tr(7, 10)], 3],
    ];
    for (const [tranches, posBase] of casi) {
      const r = reconcileTranches(tranches.map((x) => ({ ...x })), posBase, 11, 4);
      assert.equal(
        r.tranches.reduce((a, x) => a + x.base, 0), posBase,
        `somma != posBase per posBase=${posBase}`
      );
      assert.ok(r.tranches.every((x) => x.base > 0), 'nessuna tranche a zero deve sopravvivere');
    }
  });
});

// ── addTranche — il fix del finding #8 ───────────────────────────────────────
test('addTranche: i fill-scheggia si fondono invece di creare tranche inchiudibili', async (t) => {
  await t.test('sotto il minimo d ordine → fusione con entry medio pesato', () => {
    const tranches = [tr(100, 50)];
    const { merged } = addTranche(tranches, tr(20, 60), 100);
    assert.equal(merged, true);
    assert.equal(tranches.length, 1);
    assert.equal(tranches[0].base, 120);
    near(tranches[0].entryMark, (100 * 50 + 20 * 60) / 120);
  });

  await t.test('sopra il minimo → tranche nuova, entry proprio', () => {
    const tranches = [tr(100, 50)];
    const { merged } = addTranche(tranches, tr(150, 60), 100);
    assert.equal(merged, false);
    assert.equal(tranches.length, 2);
    assert.equal(tranches[1].entryMark, 60);
  });

  await t.test('primo fill in assoluto: nessuno con cui fondersi, si registra', () => {
    const tranches = [];
    const { merged } = addTranche(tranches, tr(5, 60), 100);
    assert.equal(merged, false);
    assert.equal(tranches.length, 1);
  });

  await t.test('il collaterale si somma nella fusione', () => {
    const tranches = [tr(100, 50, 11.5)];
    addTranche(tranches, tr(10, 55, 1.25), 100);
    near(tranches[0].collateralUsd, 12.75);
  });

  // riproduzione dell'incidente TEST5: 594 + sei schegge = 621 @ 57.497
  await t.test('TEST5 — le sette tranche reali collassano in una sola, invariante intatta', () => {
    const tranches = [tr(594, 57.574)];
    for (const [base, entry] of [[17, 55.755], [1, 55.687], [1, 55.728], [1, 55.890], [1, 55.910], [6, 55.905]]) {
      addTranche(tranches, tr(base, entry), 100);
    }
    assert.equal(tranches.length, 1, 'sei schegge sotto il minimo non devono restare separate');
    assert.equal(tranches[0].base, 621, 'la somma deve combaciare con la size on-chain');
    near(tranches[0].entryMark, 57.497, 0.001); // entry medio riconciliato in produzione
  });
});

// ── matureTranches ───────────────────────────────────────────────────────────
test('matureTranches: matura solo chi ha raggiunto il proprio target', async (t) => {
  await t.test('long: separa chi e sopra il target', () => {
    const { ready, keep } = matureTranches([tr(10, 100), tr(10, 200)], 130, 'long', 2, 0.5);
    assert.equal(ready.length, 1); // target 125 raggiunto
    assert.equal(keep.length, 1);  // target 250 no
  });

  await t.test('short: matura scendendo', () => {
    const { ready, keep } = matureTranches([tr(10, 100), tr(10, 50)], 70, 'short', 2, 0.5);
    assert.equal(ready.length, 1); // target 75, mark 70 → maturo
    assert.equal(keep.length, 1);  // target 37.5 → no
  });

  await t.test('il target esatto conta come raggiunto (long e short)', () => {
    assert.equal(matureTranches([tr(10, 100)], 125, 'long', 2, 0.5).ready.length, 1);
    assert.equal(matureTranches([tr(10, 100)], 75, 'short', 2, 0.5).ready.length, 1);
  });

  await t.test('una tranche nuova non matura per il progresso di una vecchia', () => {
    // e' il punto del design a tranche: niente diluizione, ognuna corre dalla SUA entry
    const { ready, keep } = matureTranches([tr(10, 100), tr(10, 129)], 130, 'long', 2, 0.5);
    assert.equal(ready.length, 1);
    assert.equal(keep[0].entryMark, 129);
  });
});

// ── removeClosedBase ─────────────────────────────────────────────────────────
test('removeClosedBase: consuma le piu vecchie e conserva i residui', async (t) => {
  await t.test('chiusura totale di una tranche', () => {
    const out = removeClosedBase([tr(100, 10), tr(50, 11)], 100);
    assert.equal(out.length, 1);
    assert.equal(out[0].base, 50);
  });

  await t.test('fill parziale: il residuo resta in coda al take-profit', () => {
    const out = removeClosedBase([tr(100, 10), tr(50, 11)], 60);
    assert.equal(out.length, 2);
    assert.equal(out[0].base, 40, 'la piu vecchia resta per la parte non riempita');
  });

  await t.test('nessun fill → lista intatta', () => {
    assert.equal(removeClosedBase([tr(100, 10)], 0)[0].base, 100);
  });

  await t.test('chiuso piu del contabilizzato → lista vuota, mai base negative', () => {
    const out = removeClosedBase([tr(100, 10), tr(50, 11)], 500);
    assert.deepEqual(out, []);
  });

  await t.test('closedBase frazionario viene arrotondato', () => {
    const out = removeClosedBase([tr(100, 10)], 40.4);
    assert.equal(out[0].base, 60);
  });
});

// ── realizedFromTranches ─────────────────────────────────────────────────────
test('realizedFromTranches: profitto esatto sulle tranche chiuse', async (t) => {
  await t.test('long in guadagno, con scala dei decimali', () => {
    // 10000 unita a sizeDec 4 = 1.0 di sottostante, +10 di prezzo = +10 USD
    near(realizedFromTranches([tr(10000, 100)], 110, 'long', 4), 10);
  });

  await t.test('short in guadagno quando il prezzo scende', () => {
    near(realizedFromTranches([tr(10000, 100)], 90, 'short', 4), 10);
  });

  await t.test('una chiusura in perdita produce un realizzato negativo', () => {
    assert.ok(realizedFromTranches([tr(10000, 100)], 90, 'long', 4) < 0);
  });

  await t.test('somma su piu tranche con entry diverse', () => {
    near(realizedFromTranches([tr(10000, 100), tr(10000, 120)], 130, 'long', 4), 30 + 10);
  });
});

// ── fundingDelta — il flusso che le tranche non vedono ───────────────────────
test('fundingDelta: applica solo la differenza, e non inventa crediti', async (t) => {
  // numeri veri: coin 0x3cb1… su NVDA, total_funding_paid_out -0.211445 cumulato
  const pos = (mid, cum) => ({ market_id: mid, total_funding_paid_out: cum });

  await t.test('prima lettura: il cumulato e tutto delta', () => {
    const r = fundingDelta({}, [pos(15, -0.211445)]);
    near(r.delta, -0.211445);
    assert.deepEqual(r.seen, { 15: -0.211445 });
  });

  await t.test('tick fermo: nessun delta, nessun doppio addebito', () => {
    const r = fundingDelta({ 15: -0.211445 }, [pos(15, -0.211445)]);
    near(r.delta, 0);
  });

  await t.test('round successivo: solo la differenza', () => {
    const r = fundingDelta({ 15: -0.211445 }, [pos(15, -0.25)]);
    near(r.delta, -0.038555);
  });

  await t.test('funding incassato: delta positivo', () => {
    const r = fundingDelta({ 15: -0.25 }, [pos(15, -0.1)]);
    near(r.delta, 0.15);
  });

  // il caso che rompe una baseline ingenua: la posizione si chiude e se ne apre
  // una nuova sullo stesso mercato. Il cumulato del venue riparte da zero, e una
  // baseline conservata produrrebbe un credito fantasma pari a tutto il funding
  // gia pagato — cioe un withdraw di margine travestito da profitto.
  await t.test('posizione chiusa: la baseline cade, niente credito fantasma', () => {
    const chiusa = fundingDelta({ 15: -0.211445 }, []);
    near(chiusa.delta, 0);
    assert.deepEqual(chiusa.seen, {});
    const riaperta = fundingDelta(chiusa.seen, [pos(15, 0)]);
    near(riaperta.delta, 0);
  });

  await t.test('campo assente: baseline conservata, nessun delta', () => {
    const r = fundingDelta({ 15: -0.2 }, [{ market_id: 15 }]);
    near(r.delta, 0);
    assert.deepEqual(r.seen, { 15: -0.2 });
  });

  await t.test('piu mercati: i delta si sommano', () => {
    const r = fundingDelta({ 15: -0.2 }, [pos(15, -0.3), pos(2, -0.05)]);
    near(r.delta, -0.15);
  });
});

// ── coinValueInQuote — il lato coin che il gate del claim ignorava ───────────
test('coinValueInQuote: valorizza il lato coin allo spot del pool', async (t) => {
  const BN = ethers.BigNumber.from;
  const coin = (n) => ethers.utils.parseUnits(String(n), 18);

  // stato reale del pool TEST2/USDG dopo la sessione di swap (coin = token0)
  const SQRT_TEST2 = BN('158675592262364956483');

  await t.test('TEST2 — prezzo per singola coin coerente con lo spot osservato', () => {
    near(coinValueInQuote(SQRT_TEST2, coin(1), false, 6), 4.0111e-6, 1e-10);
  });

  await t.test('TEST2 — il lato coin non riscosso valeva ~$0.48, non zero', () => {
    // e' la cifra che il gate non vedeva: da sola quasi come tutto il lato quote
    near(coinValueInQuote(SQRT_TEST2, coin(119454), false, 6), 0.4791, 0.001);
  });

  await t.test('lineare nella quantita', () => {
    const uno = coinValueInQuote(SQRT_TEST2, coin(1000), false, 6);
    const dieci = coinValueInQuote(SQRT_TEST2, coin(10000), false, 6);
    near(dieci, uno * 10, 1e-9);
  });

  await t.test('quoteIs0 inverte il rapporto', () => {
    // prezzo raw 4:1 (sqrt = 2 · 2^96) e stessi decimali sui due lati: cosi' il
    // valore atteso e' leggibile a occhio e il prodotto dei due versi fa 1
    const sqrt4 = BN(2).mul(BN(2).pow(96));
    const seCoinE0 = coinValueInQuote(sqrt4, coin(1), false, 18);
    const seQuoteE0 = coinValueInQuote(sqrt4, coin(1), true, 18);
    near(seCoinE0, 4);
    near(seQuoteE0, 0.25);
    near(seCoinE0 * seQuoteE0, 1);
  });

  await t.test('prezzo degenere → 0, mai NaN nel gate', () => {
    assert.equal(coinValueInQuote(BN(0), coin(1), false, 6), 0);
  });
});

// ── quoteExactInV3 ───────────────────────────────────────────────────────────
test('quoteExactInV3: quote esatto nel range a liquidita costante', async (t) => {
  const BN = ethers.BigNumber.from;
  const Q96 = BN(2).pow(96);
  const sqrtP = Q96;                          // prezzo 1:1
  const L = BN(10).pow(24);

  await t.test('output positivo in entrambe le direzioni', () => {
    const a = quoteExactInV3(sqrtP, L, BN(10).pow(18), true);
    const b = quoteExactInV3(sqrtP, L, BN(10).pow(18), false);
    assert.ok(a.gt(0) && b.gt(0));
  });

  await t.test('impatto prezzo: raddoppiare l input rende meno del doppio', () => {
    const uno = quoteExactInV3(sqrtP, L, BN(10).pow(18), false);
    const due = quoteExactInV3(sqrtP, L, BN(10).pow(18).mul(2), false);
    assert.ok(due.lt(uno.mul(2)), 'senza impatto prezzo il quote sarebbe lineare');
    assert.ok(due.gt(uno), 'ma resta monotono crescente');
  });

  await t.test('liquidita nulla → quote a zero, non una divisione impossibile', () => {
    assert.equal(quoteExactInV3(sqrtP, BN(0), BN(10).pow(18), true).toString(), '0');
    assert.equal(quoteExactInV3(sqrtP, BN(0), BN(10).pow(18), false).toString(), '0');
  });

  await t.test('input nullo → output nullo', () => {
    assert.equal(quoteExactInV3(sqrtP, L, BN(0), true).toString(), '0');
  });
});

// ── validateLaunchParams — input dal mondo, non piu' da riga di comando ──────
const { validateLaunchParams, LaunchParamError } = require('../lib/launchParams');

test('validateLaunchParams: nulla di non validato arriva a un deploy', async (t) => {
  const ok = {
    name: 'My Coin', symbol: 'mycoin', market: 'nvda', side: 'LONG',
    leverage: 3, riskProfile: 'Degen',
    creator: '0x23bf247b662efadf114642a65dbbb0cb7d0ebac0',
  };

  await t.test('normalizza maiuscole, minuscole e checksum', () => {
    const p = validateLaunchParams(ok);
    assert.equal(p.symbol, 'MYCOIN');
    assert.equal(p.market, 'NVDA');
    assert.equal(p.side, 'long');
    assert.equal(p.riskProfile, 'degen');
    assert.equal(p.creator, '0x23Bf247B662EFADf114642A65DbbB0CB7D0EBAc0');
  });

  const rifiutati = [
    ['nome vuoto', { name: '' }],
    ['nome troppo lungo', { name: 'x'.repeat(41) }],
    ['nome con a capo', { name: 'riga1\nriga2' }],
    ['ticker con simboli', { symbol: 'AB$C' }],
    ['ticker troppo lungo', { symbol: 'ABCDEFGHIJK' }],
    ['direzione inventata', { side: 'pippo' }],
    ['leva fuori scala', { leverage: 999 }],
    ['leva non ammessa', { leverage: 4 }],
    ['profilo inesistente', { riskProfile: 'yolo' }],
    ['creator non indirizzo', { creator: 'non-un-indirizzo' }],
    ['creator a zero', { creator: '0x0000000000000000000000000000000000000000' }],
    ['mercato con spazi', { market: 'NV DA' }],
  ];
  for (const [nome, patch] of rifiutati) {
    await t.test(`rifiuta: ${nome}`, () => {
      assert.throws(() => validateLaunchParams({ ...ok, ...patch }), LaunchParamError);
    });
  }

  await t.test('campi mancanti non diventano default silenziosi', () => {
    assert.throws(() => validateLaunchParams({}), LaunchParamError);
  });
});
