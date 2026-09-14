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

const LEVERAGES = [2, 3, 5, 10, 20];
const SIDES = ['long', 'short'];

// I mercati veri sono quelli di Lighter (catalogo dinamico): qui si valida solo
// la FORMA del simbolo. Chi chiama puo' poi verificarlo contro il catalogo vivo,
// che e' l'unica fonte autorevole e cambia nel tempo.
const MARKET_RE = /^[A-Z0-9]{2,12}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;

/** il nome finisce in un contratto: niente caratteri di controllo, niente abusi di lunghezza */
const NAME_RE = /^[\p{L}\p{N} .,'&:()\-]{2,40}$/u;

class LaunchParamError extends Error {}

function fail(msg) { throw new LaunchParamError(msg); }

/**
 * Normalizza e valida. Restituisce un oggetto pulito da passare al lancio:
 * mai i valori grezzi ricevuti, cosi' a valle non serve ricordarsi di fidarsi
 * o meno di quello che si e' letto.
 */
function validateLaunchParams(raw = {}) {
  const name = String(raw.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    fail('nome non valido: 2-40 caratteri, lettere/numeri e punteggiatura semplice');
  }

  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) fail('ticker non valido: 2-10 caratteri A-Z0-9');

  const market = String(raw.market ?? '').trim().toUpperCase();
  if (!MARKET_RE.test(market)) fail('mercato non valido: 2-12 caratteri A-Z0-9');

  const side = String(raw.side ?? '').trim().toLowerCase();
  if (!SIDES.includes(side)) fail(`direzione non valida: ammesse ${SIDES.join(', ')}`);

  const leverage = Number(raw.leverage ?? raw.lev);
  if (!LEVERAGES.includes(leverage)) fail(`leva non valida: ammesse ${LEVERAGES.join(', ')}`);

  const riskProfile = String(raw.riskProfile ?? raw.risk ?? config.DEFAULT_RISK).trim().toLowerCase();
  if (!config.RISK_PROFILES[riskProfile]) {
    fail(`profilo di rischio non valido: ammessi ${Object.keys(config.RISK_PROFILES).join(', ')}`);
  }

  // il creator e' solo una destinazione di payout: deve essere un indirizzo vero
  // e in forma checksum, non lo zero (che brucerebbe la quota creator)
  let creator;
  try { creator = ethers.utils.getAddress(String(raw.creator ?? '')); }
  catch { fail('indirizzo creator non valido'); }
  if (creator === ethers.constants.AddressZero) fail('il creator non puo\' essere l\'indirizzo zero');

  return { name, symbol, market, side, leverage, riskProfile, creator };
}

module.exports = { validateLaunchParams, LaunchParamError, LEVERAGES, SIDES };
