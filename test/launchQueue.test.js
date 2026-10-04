const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const q = require('../lib/launchQueue');

/**
 * La coda e' l'unico canale fra un sito senza chiavi e un keeper che le ha:
 * quello che conta e' che un pagamento non registri due coin, che un job non
 * venga preso due volte, e che un keeper morto non blocchi la coda per sempre.
 * Ogni test lavora in una directory temporanea: nessuno stato condiviso.
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lq-'));
const HASH_A = '0x' + 'a'.repeat(64);
const HASH_B = '0x' + 'b'.repeat(64);
const params = { name: 'My Coin', symbol: 'MYC', market: 'NVDA', side: 'long', leverage: 3, takeProfitPct: 100, managed: false, creator: '0x23Bf247B662EFADf114642A65DbbB0CB7D0EBAc0' };

test('launchQueue: un pagamento, una registrazione', async (t) => {
  await t.test('accoda e rilegge', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    assert.equal(job.state, 'pending');
    assert.equal(q.read(job.id, d).params.symbol, 'MYC');
  });

  await t.test('lo stesso tx della fee non puo registrare due coin', () => {
    const d = tmp();
    q.enqueue({ params, feeTxHash: HASH_A }, d);
    assert.throws(() => q.enqueue({ params, feeTxHash: HASH_A }, d), /gia' usato/);
  });

  await t.test('maiuscole nel tx-hash non aggirano il controllo', () => {
    const d = tmp();
    q.enqueue({ params, feeTxHash: HASH_A }, d);
    assert.throws(() => q.enqueue({ params, feeTxHash: HASH_A.toUpperCase().replace('0X', '0x') }, d), /gia' usato/);
  });

  await t.test('tx-hash malformato rifiutato subito', () => {
    const d = tmp();
    assert.throws(() => q.enqueue({ params, feeTxHash: 'non-un-hash' }, d), /non valido/);
  });
});

test('launchQueue: presa in carico', async (t) => {
  await t.test('un job si prende una volta sola', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    assert.ok(q.claim(job.id, Date.now(), d));
    assert.equal(q.claim(job.id, Date.now(), d), null, 'la seconda presa deve fallire');
  });

  await t.test('un keeper morto non blocca la coda per sempre', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    const t0 = Date.now();
    q.claim(job.id, t0, d);
    assert.equal(q.claim(job.id, t0 + 60_000, d), null, 'prima della scadenza resta preso');
    const ripreso = q.claim(job.id, t0 + q.STALE_CLAIM_MS + 1, d);
    assert.ok(ripreso, 'dopo la scadenza si puo riprendere');
    assert.equal(ripreso.attempts, 2);
  });

  await t.test('il progresso sopravvive alla ripresa: non si rideploya', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    q.claim(job.id, Date.now(), d);
    q.progress(job.id, { token: '0xabc', step: 'verifica pool' }, d);
    const ripreso = q.claim(job.id, Date.now() + q.STALE_CLAIM_MS + 1, d);
    assert.equal(ripreso.progress.token, '0xabc');
  });

  await t.test('claimable ordina dal piu vecchio e ignora i conclusi', () => {
    const d = tmp();
    const a = q.enqueue({ params, feeTxHash: HASH_A, now: 1000 }, d);
    const b = q.enqueue({ params, feeTxHash: HASH_B, now: 2000 }, d);
    assert.deepEqual(q.claimable(Date.now(), d).map((j) => j.id), [a.id, b.id]);
    q.finish(a.id, { token: '0xdef' }, d);
    assert.deepEqual(q.claimable(Date.now(), d).map((j) => j.id), [b.id]);
  });
});

test('launchQueue: esiti e vista pubblica', async (t) => {
  await t.test('done conserva il token registrato', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    const done = q.finish(job.id, { token: '0xdef' }, d);
    assert.equal(done.state, 'done');
    assert.equal(done.progress.token, '0xdef');
  });

  await t.test('failed porta il motivo, troncato', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    const ko = q.fail(job.id, 'x'.repeat(500), d);
    assert.equal(ko.state, 'failed');
    assert.ok(ko.error.length <= 300);
  });

  await t.test('la vista pubblica non espone il pagamento ne il creator', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    const v = q.publicView(q.read(job.id, d));
    assert.equal(v.symbol, 'MYC');
    assert.equal(v.feeTxHash, undefined);
    assert.equal(v.params, undefined);
  });

  await t.test('l errore non trapela finche il job non e fallito', () => {
    const d = tmp();
    const job = q.enqueue({ params, feeTxHash: HASH_A }, d);
    q.claim(job.id, Date.now(), d);
    assert.equal(q.publicView(q.read(job.id, d)).error, null);
  });
});
