const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const rest = require('./rest');
const { createSemaphore } = require('../lib/lanes');

/**
 * lighter/client.js — RPC sottile Node → sidecar.py (Lighter, profilo ROBINHOOD).
 *
 * Le LETTURE passano da rest.js (nessun Python). Cio' che si firma, e il bridge, lancia
 * `python sidecar.py <cmd> '<json>'` e restituisce il JSON, uno per processo: cosi' una chiave
 * non vive mai accanto a un'altra.
 * I segreti (chiave API Lighter della coin, chiave eth del sub-wallet per la
 * registrazione) passano via ENV al figlio, MAI in argv. La policy (quando
 * depositare/aprire/take-profit, dimensionamento) sta nel keeper, non qui.
 *
 * Modi (PERPSPAD_LIGHTER_MODE, come il off/simulate/live di perpspad):
 *   off       stub: la riserva 50% accumula in USDG nel sub-wallet, nessun perp
 *   simulate  esegue le LETTURE (mercato, intent-address, account) e LOGGA cosa
 *             farebbe (deposito, open) ma NON invia nessuna tx ne' ordine: dry-run
 *   live      esegue tutto (deposito USDG, register-key, leva, open/topup, take-profit)
 * Retrocompat: PERPSPAD_LIGHTER_ENABLED=1 equivale a mode=live.
 */

const MODE = (process.env.PERPSPAD_LIGHTER_MODE || (process.env.PERPSPAD_LIGHTER_ENABLED ? 'live' : 'off')).toLowerCase();
const enabled = MODE === 'simulate' || MODE === 'live';
const simulate = MODE === 'simulate';
const PYTHON = config.LIGHTER_PYTHON;
const SIDECAR = path.resolve(__dirname, 'sidecar.py');

const signing = createSemaphore(config.LIGHTER_SIGNERS, { reserved: 1 });
/**
 * `staleMs`: what is being signed was decided on an account read before this, and goes at the price
 * of the moment it leaves. One that waited longer than that for its turn is not sent: nothing
 * happened, and it is decided again.
 */
const call = (cmd, params = {}, env = {}, { staleMs = Infinity } = {}) => {
  const asked = Date.now();
  return signing(() => {
    if (Date.now() - asked <= staleMs) { rest.charge(3); return spawn(cmd, params, env); }
    const e = new Error(`lighter:${cmd}: waited too long for its turn`);
    e.definitive = true; e.retry = true;
    throw e;
  }, { front: rest.isUrgent() });
};
function spawn(cmd, params, env) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [SIDECAR, cmd, JSON.stringify(params)],
      { env: { ...process.env, LIGHTER_PROFILE: config.LIGHTER_PROFILE, ...env }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let parsed = null;
        const lines = (stdout || '').trim().split('\n');
        try { parsed = JSON.parse(lines.at(-1)); } catch { /* sotto */ }
        // what was signed is known even when what came of it is not
        let signed = null;
        for (const l of lines) try { signed = JSON.parse(l).signed || signed; } catch { /* not it */ }
        if (parsed && parsed.ok && signed) parsed.txHash ??= signed;
        if (parsed && parsed.ok) return resolve(parsed);
        if (parsed && parsed.error) {
          // The sidecar says whether the failure is a refusal (nothing happened on the venue, the
          // caller may restore its state) or came from the send itself, whose outcome is unknown.
          const e = new Error('lighter:' + cmd + ': ' + parsed.error);
          e.definitive = parsed.definitive === true;
          e.retry = parsed.retry === true; // the venue was busy, it did not judge the request
          e.limited = parsed.limited === true; // it was past one of the venue's own limits
          e.txHash = signed;
          return reject(e);
        }
        // nessun JSON: timeout, processo ucciso, crash → esito AMBIGUO, la
        // richiesta potrebbe essere partita. Nessun ripristino automatico.
        return reject(Object.assign(new Error('lighter:' + cmd + ': ' + (err ? err.message : 'output non-JSON')), { txHash: signed }));
      });
  });
}

// cache con TTL: il keeper gira per giorni e size_dec/min_base possono cambiare
// lato exchange — una cache eterna corromperebbe la scala della contabilita' tranche.
let _markets = null;
let _marketsAt = 0;
const MARKETS_TTL_MS = 10 * 60 * 1000;
let _marketsRead = null;
async function markets() {
  if (!_markets || Date.now() - _marketsAt > MARKETS_TTL_MS) {
    // whoever asks while the list is being read shares that read
    _marketsRead ??= rest.markets().then((r) => { _markets = r.markets; _marketsAt = Date.now(); }).finally(() => { _marketsRead = null; });
    // an old list is served while the new one comes: it changes a few times a month, and a venue
    // that does not answer for it must not stop what it answers for
    if (_markets) { _marketsRead.catch(() => {}); _marketsAt = Math.max(_marketsAt, Date.now() - MARKETS_TTL_MS + 30_000); }
    else await _marketsRead;
  }
  return _markets;
}
// Highest leverage the market allows, from its minimum initial margin fraction (basis points
// of 1e4: 200 = 2% = 50x). The epsilon keeps 3333 at 3x rather than a float's 2.9999x.
// null when the sidecar could not read it: no cap known, nothing is blocked on a guess.
function maxLeverageFromImf(minImf) {
  const imf = Number(minImf);
  return imf > 0 ? Math.floor(10000 / imf + 1e-9) : null;
}

// the sidecar's market entry → what the keeper uses (pure, testable without the venue)
function parseMarket(symbol, info) {
  if (!info) {
    const e = new Error(`mercato Lighter "${symbol}" inesistente sul profilo ${config.LIGHTER_PROFILE}`);
    e.unknownMarket = true; // the list was read and does not carry it, as opposed to a failed read
    throw e;
  }
  const minBaseUnits = info.min_base ? Math.max(1, Math.round(parseFloat(info.min_base) * 10 ** info.size_dec)) : 1;
  const minQuoteUsd = info.min_quote ? parseFloat(info.min_quote) : 0;
  return {
    index: info.index, sizeDec: info.size_dec, priceDec: info.price_dec, status: info.status, minBaseUnits, minQuoteUsd,
    maxLeverage: maxLeverageFromImf(info.min_imf),
  };
}

// symbol → {index, sizeDec, priceDec, status, minBaseUnits, minQuoteUsd, maxLeverage}
async function market(symbol) {
  return parseMarket(symbol, (await markets())[symbol]);
}

/** the market an open position belongs to, by venue id: { symbol, ...market } or null */
async function marketById(id) {
  const hit = Object.entries(await markets()).find(([, info]) => Number(info.index) === Number(id));
  return hit ? { symbol: hit[0], ...parseMarket(hit[0], hit[1]) } : null;
}

const selftest = () => call('selftest');
const resolveAccount = (address) => rest.resolveAccount({ address });
const account = (accountIndex) => rest.account({ accountIndex });
const intentAddress = ({ chainId, fromAddr, amount }) => call('intent-address', { chainId, fromAddr, amount });
const depositLatest = (address) => call('deposit-latest', { address });
const registerKey = ({ accountIndex, apiKeyIndex, ethPrivKey }) =>
  call('register-key', { accountIndex, apiKeyIndex }, { LIGHTER_ETH_PRIVKEY: ethPrivKey });
const setLeverage = ({ accountIndex, marketIndex, leverage, isolated = true, apiPrivKey, apiKeyIndex = 4 }) =>
  call('set-leverage', { accountIndex, marketIndex, leverage, isolated, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });
// open: dimensiona da notionalUsd (il sidecar legge il mark). close: baseAmount esplicito.
const open = ({ accountIndex, marketIndex, notionalUsd, isAsk, maxSlippage, clientOrderIndex = 0, apiPrivKey, apiKeyIndex = 4 }) =>
  call('open', { accountIndex, marketIndex, notionalUsd, isAsk, maxSlippage, clientOrderIndex, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey }, { staleMs: config.LIGHTER_STALE_ORDER_MS });
const close = ({ accountIndex, marketIndex, baseAmount, isAsk, maxSlippage, limitPrice, clientOrderIndex = 0, apiPrivKey, apiKeyIndex = 4 }) =>
  call('close', { accountIndex, marketIndex, baseAmount, isAsk, maxSlippage, limitPrice, clientOrderIndex, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey }, { staleMs: config.LIGHTER_STALE_ORDER_MS });
/** a transaction on the venue by its hash: { status }, or null when it has never seen it */
const tx = (hash) => rest.tx({ hash });
/** what the order with this client index traded: { size, price }, price null when nothing is seen yet */
const fills = ({ accountIndex, marketIndex, clientOrderIndex, since = 0 }) => rest.fills({ accountIndex, marketIndex, clientOrderIndex, since });
const addMargin = ({ accountIndex, marketIndex, usdcAmount, apiPrivKey, apiKeyIndex = 4 }) =>
  call('add-margin', { accountIndex, marketIndex, usdcAmount, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });
// withdraw normale del collaterale/profitto verso il sub-wallet su 4663 (no fee/limite)
const withdraw = ({ accountIndex, amount, apiPrivKey, apiKeyIndex = 4 }) =>
  call('withdraw', { accountIndex, amount, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });

module.exports = {
  enabled, simulate, mode: MODE, urgently: rest.urgently, spareReads: rest.spareReads,
  selftest, markets, market, marketById, parseMarket, maxLeverageFromImf, resolveAccount, account,
  intentAddress, depositLatest, registerKey, setLeverage, open, close, fills, tx, addMargin, withdraw,
};
