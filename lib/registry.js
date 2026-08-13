const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * registry.js — stato persistente del launchpad (JSON su disco).
 *
 * registry.coins  : anagrafica delle coin lanciate (token, pool, lpTokenId,
 *                   sub-wallet ADDRESS — mai la chiave —, creator, mercato perp).
 * registry.state  : contabilita' per coin del keeper. Le riserve sono "raw" nel
 *                   quote della coin e vivono FISICAMENTE nel sub-wallet: qui si
 *                   tiene solo la ripartizione nei bucket e le tranche del perp.
 *                   Se il file si perde, i fondi restano nei sub-wallet
 *                   (derivabili dal master secret); lo sweep dello step 0b del
 *                   keeper riporta il saldo non attribuito nella perp reserve.
 *
 * Scrittura atomica (tmp+rename) + MERGE difensivo: il keeper tiene la sua copia
 * in memoria per tutto il tick, e launchCoin puo' aggiungere una coin nel
 * frattempo — al save le coin presenti su disco ma non in memoria vengono
 * preservate, mai sovrascritte via.
 */

// default di TUTTI i campi di stato: applicati anche al load, cosi' una coin
// registrata da una versione vecchia non produce mai aritmetica su undefined.
const STATE_DEFAULTS = {
  perpReserveRaw: '0',     // quota fee in attesa del gate/top-up perp (nel quote)
  buybackReserveRaw: '0',  // quota buyback (alimentata dal profitto perp rientrato)
  treasuryOwedRaw: '0',    // quota treasury da girare (nel quote)
  creatorOwedRaw: '0',     // quota creator sotto il minimo $1 (nel quote)
  totalCollected0: '0',    // fee quote claimate cumulative
  totalCollected1: '0',
  totalBurnedRaw: '0',     // coin bruciate cumulative
  perpOpen: false,
  perpCollateralUsd: 0,
  lighterAccountIndex: null,   // account Lighter = sub-wallet su 4663
  lighterApiPrivKey: null,     // chiave API Lighter della coin, CIFRATA (enc:…)
  lighterApiKeyIndex: null,
  lighterLeverageSet: false,
  perpDepositedUsd: 0,         // USDG cumulativi mandati a Lighter come collaterale
  perpPendingDepositUsd: 0,    // depositati ma non ancora visti accreditati
  perpHwmUsd: 0,               // (legacy, non piu' usato dal TP a tranche)
  perpTranches: [],            // tranche aperte: {base, entryMark, collateralUsd, sizeDec, ts}
  perpRealizedUsd: 0,          // profitto realizzato su Lighter, non ancora prelevato
  perpWithdrawIntentUsd: 0,    // write-ahead: withdraw richiesto ma esito non confermato
  perpWithdrawPendingUsd: 0,   // prelevato da Lighter, in arrivo sul sub-wallet
  perpWithdrawBlock: null,     // blocco di inizio finestra withdraw (match dei log)
  perpWithdrawScanBlock: null, // ultimo blocco scansionato per il credito del bridge
  lastTickTs: 0,
};

function load() {
  if (!fs.existsSync(config.REGISTRY_PATH)) return { coins: [], state: {} };
  const reg = JSON.parse(fs.readFileSync(config.REGISTRY_PATH, 'utf8'));
  reg.coins = reg.coins || [];
  reg.state = reg.state || {};
  for (const c of reg.coins) {
    const k = c.token.toLowerCase();
    reg.state[k] = { ...STATE_DEFAULTS, ...(reg.state[k] || {}) };
  }
  return reg;
}

function save(reg) {
  const dir = path.dirname(config.REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // merge difensivo: coin comparse su disco dopo il nostro load (es. launchCoin
  // mentre il keeper e' a meta' tick) vengono adottate, non cancellate.
  try {
    if (fs.existsSync(config.REGISTRY_PATH)) {
      const disk = JSON.parse(fs.readFileSync(config.REGISTRY_PATH, 'utf8'));
      for (const c of disk.coins || []) {
        const k = c.token.toLowerCase();
        if (!reg.coins.some((x) => x.token.toLowerCase() === k)) {
          reg.coins.push(c);
          reg.state[k] = { ...STATE_DEFAULTS, ...((disk.state || {})[k] || {}) };
        }
      }
    }
  } catch { /* disco illeggibile: si scrive comunque la copia in memoria */ }
  const tmp = config.REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 1));
  fs.renameSync(tmp, config.REGISTRY_PATH);
}

function addCoin(reg, coin) {
  if (reg.coins.some((c) => c.token.toLowerCase() === coin.token.toLowerCase())) {
    throw new Error('coin gia' + "' registrata: " + coin.token);
  }
  reg.coins.push(coin);
  reg.state[coin.token.toLowerCase()] = { ...STATE_DEFAULTS };
  return reg;
}

module.exports = { load, save, addCoin, STATE_DEFAULTS };
