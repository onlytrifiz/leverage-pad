const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

/**
 * lighter/client.js — RPC sottile Node → sidecar.py (Lighter, profilo ROBINHOOD).
 *
 * Ogni metodo lancia `python sidecar.py <cmd> '<json>'` e restituisce il JSON.
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

function call(cmd, params = {}, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [SIDECAR, cmd, JSON.stringify(params)],
      { env: { ...process.env, LIGHTER_PROFILE: config.LIGHTER_PROFILE, ...env }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let parsed = null;
        try { parsed = JSON.parse((stdout || '').trim().split('\n').pop()); } catch { /* sotto */ }
        if (parsed && parsed.ok) return resolve(parsed);
        if (parsed && parsed.error) {
          // il sidecar ha risposto con un errore strutturato: l'API ha VALUTATO e
          // rifiutato la richiesta, quindi sappiamo che non e' successo nulla.
          // `definitive` permette al chiamante di ripristinare lo stato in sicurezza.
          const e = new Error('lighter:' + cmd + ': ' + parsed.error);
          e.definitive = true;
          return reject(e);
        }
        // nessun JSON: timeout, processo ucciso, crash → esito AMBIGUO, la
        // richiesta potrebbe essere partita. Nessun ripristino automatico.
        return reject(new Error('lighter:' + cmd + ': ' + (err ? err.message : 'output non-JSON')));
      });
  });
}

// cache con TTL: il keeper gira per giorni e size_dec/min_base possono cambiare
// lato exchange — una cache eterna corromperebbe la scala della contabilita' tranche.
let _markets = null;
let _marketsAt = 0;
const MARKETS_TTL_MS = 10 * 60 * 1000;
async function markets() {
  if (!_markets || Date.now() - _marketsAt > MARKETS_TTL_MS) {
    _markets = (await call('markets')).markets;
    _marketsAt = Date.now();
  }
  return _markets;
}
// symbol → {index, sizeDec, priceDec, status, minBaseUnits}
async function market(symbol) {
  const m = await markets();
  const info = m[symbol];
  if (!info) throw new Error(`mercato Lighter "${symbol}" inesistente sul profilo ${config.LIGHTER_PROFILE}`);
  const minBaseUnits = info.min_base ? Math.max(1, Math.round(parseFloat(info.min_base) * 10 ** info.size_dec)) : 1;
  return { index: info.index, sizeDec: info.size_dec, priceDec: info.price_dec, status: info.status, minBaseUnits };
}

const selftest = () => call('selftest');
const resolveAccount = (address) => call('resolve-account', { address });
const account = (accountIndex) => call('account', { accountIndex });
const intentAddress = ({ chainId, fromAddr, amount }) => call('intent-address', { chainId, fromAddr, amount });
const depositLatest = (address) => call('deposit-latest', { address });
const registerKey = ({ accountIndex, apiKeyIndex, ethPrivKey }) =>
  call('register-key', { accountIndex, apiKeyIndex }, { LIGHTER_ETH_PRIVKEY: ethPrivKey });
const setLeverage = ({ accountIndex, marketIndex, leverage, isolated = true, apiPrivKey, apiKeyIndex = 4 }) =>
  call('set-leverage', { accountIndex, marketIndex, leverage, isolated, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });
// open: dimensiona da notionalUsd (il sidecar legge il mark). close: baseAmount esplicito.
const open = ({ accountIndex, marketIndex, notionalUsd, isAsk, maxSlippage, clientOrderIndex = 0, apiPrivKey, apiKeyIndex = 4 }) =>
  call('open', { accountIndex, marketIndex, notionalUsd, isAsk, maxSlippage, clientOrderIndex, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });
const close = ({ accountIndex, marketIndex, baseAmount, isAsk, maxSlippage, clientOrderIndex = 0, apiPrivKey, apiKeyIndex = 4 }) =>
  call('close', { accountIndex, marketIndex, baseAmount, isAsk, maxSlippage, clientOrderIndex, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });
const addMargin = ({ accountIndex, marketIndex, usdcAmount, apiPrivKey, apiKeyIndex = 4 }) =>
  call('add-margin', { accountIndex, marketIndex, usdcAmount, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });
// withdraw normale del collaterale/profitto verso il sub-wallet su 4663 (no fee/limite)
const withdraw = ({ accountIndex, amount, apiPrivKey, apiKeyIndex = 4 }) =>
  call('withdraw', { accountIndex, amount, apiKeyIndex }, { LIGHTER_API_PRIVKEY: apiPrivKey });

module.exports = {
  enabled, simulate, mode: MODE,
  selftest, markets, market, resolveAccount, account,
  intentAddress, depositLatest, registerKey, setLeverage, open, close, addMargin, withdraw,
};
