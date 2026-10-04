const { ethers } = require('ethers');
const config = require('../config');

/**
 * launchParams.js — validazione dei parametri di lancio.
 *
 * Finche' il lancio si faceva da riga di comando sulla macchina operatore, gli
 * unici errori possibili erano typo di chi lo digitava. Con il lancio autonomo
 * questi campi arrivano da internet e finiscono in un deploy di contratto e nel
 * registry, cioe' in cose irreversibili: il locker non ha recovery e una coin
 * registrata fa partire il keeper con fondi veri al tick successivo.
 *
 * Oggi `launchCoin.js` valida SOLO il profilo di rischio: `--side pippo`,
 * `--lev 999` o un simbolo con caratteri arbitrari passano dritti. Qui si
 * chiude il buco una volta sola, prima di qualunque transazione.
 *
 * Funzione pura, senza rete: coperta dai test a secco.
 */

// the stops the router's engineConfig.leverageMask allows; the venue's own cap per market is
// checked by the keeper against Lighter, not here
const LEVERAGES = [2, 3, 5, 10, 20, 25, 50];
const SIDES = ['long', 'short'];

// I mercati veri sono quelli di Lighter (catalogo dinamico): qui si valida solo
// la FORMA del simbolo. Chi chiama puo' poi verificarlo contro il catalogo vivo,
// che e' l'unica fonte autorevole e cambia nel tempo.
const MARKET_RE = /^[A-Z0-9]{2,12}$/;
// Name and ticker are the creator's: any characters, as typed. Only a length cap (gas, layout)
// and no control characters or line breaks, which are never intentional.
const NAME_MAX = 64;
const SYMBOL_MAX = 16;
const CONTROL_RE = /\p{C}/u;


class LaunchParamError extends Error {}

function fail(msg) { throw new LaunchParamError(msg); }

/**
 * Normalizza e valida. Restituisce un oggetto pulito da passare al lancio:
 * mai i valori grezzi ricevuti, cosi' a valle non serve ricordarsi di fidarsi
 * o meno di quello che si e' letto.
 */
function validateLaunchParams(raw = {}) {
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > NAME_MAX || CONTROL_RE.test(name)) {
    fail(`nome non valido: 1-${NAME_MAX} caratteri, senza caratteri di controllo`);
  }

  const symbol = String(raw.symbol ?? '').trim();
  if (!symbol || symbol.length > SYMBOL_MAX || CONTROL_RE.test(symbol) || /\s/.test(symbol)) {
    fail(`ticker non valido: 1-${SYMBOL_MAX} caratteri, senza spazi`);
  }

  return { name, symbol, ...validateEngineParams(raw) };
}

/** take-profit percent of a legacy record that only carries a risk profile name (default 50) */
function legacyTakeProfitPct(riskProfile) {
  const pct = config.LEGACY_RISK_TP_PCT[String(riskProfile ?? '').trim().toLowerCase()];
  return pct ?? config.LEGACY_RISK_TP_PCT.balanced;
}

/**
 * Leverage and take-profit: the two engine fields that can change after launch. Shared by the
 * launch validation and by the keeper's refresh of the on-chain engine, so a value the router
 * accepts later is held to exactly the rules a launch is.
 */
function validateTuning(leverage, takeProfitPct) {
  if (!LEVERAGES.includes(leverage)) fail(`invalid leverage ${leverage}: allowed ${LEVERAGES.join(', ')}`);
  if (!Number.isInteger(takeProfitPct) || takeProfitPct < config.TP_MIN_PCT || takeProfitPct > config.TP_MAX_PCT) {
    fail(`invalid take-profit ${takeProfitPct}: an integer percent in ${config.TP_MIN_PCT}..${config.TP_MAX_PCT}`);
  }
}

/**
 * Only the ENGINE (market, side, leverage, take-profit, managed, creator): what the keeper reads
 * from the router's events. Name and ticker of a coin already launched are whatever the token
 * says on-chain: never a reason not to serve it.
 */
function validateEngineParams(raw = {}) {
  const market = String(raw.market ?? '').trim().toUpperCase();
  if (!MARKET_RE.test(market)) fail('invalid market: 2-12 characters A-Z0-9');

  const side = String(raw.side ?? '').trim().toLowerCase();
  if (!SIDES.includes(side)) fail(`invalid side: allowed ${SIDES.join(', ')}`);

  const leverage = Number(raw.leverage ?? raw.lev);

  // a request written before the take-profit became a free percent still names a profile:
  // mapped, but an unknown name is an error, not a silent default
  let takeProfitPct;
  const tpRaw = raw.takeProfitPct ?? raw.tp;
  if (tpRaw != null && tpRaw !== '') {
    takeProfitPct = Number(tpRaw);
  } else {
    const legacy = String(raw.riskProfile ?? raw.risk ?? '').trim().toLowerCase();
    if (!legacy) fail('take-profit missing');
    takeProfitPct = config.LEGACY_RISK_TP_PCT[legacy];
    if (takeProfitPct == null) fail(`unknown risk profile "${legacy}": allowed ${Object.keys(config.LEGACY_RISK_TP_PCT).join(', ')}`);
  }
  validateTuning(leverage, takeProfitPct);

  const managed = raw.managed ?? false;
  if (typeof managed !== 'boolean') fail('invalid managed flag: true or false');

  // il creator e' solo una destinazione di payout: deve essere un indirizzo vero
  // e in forma checksum, non lo zero (che brucerebbe la quota creator)
  let creator;
  try { creator = ethers.utils.getAddress(String(raw.creator ?? '')); }
  catch { fail('invalid creator address'); }
  if (creator === ethers.constants.AddressZero) fail('the creator cannot be the zero address');

  return { market, side, leverage, takeProfitPct, managed, creator };
}

module.exports = { validateLaunchParams, validateEngineParams, validateTuning, legacyTakeProfitPct, LaunchParamError, LEVERAGES, SIDES, NAME_MAX, SYMBOL_MAX };
