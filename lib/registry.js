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
  sinkTreasuryRaw: '0',    // (v4) quota protocollo gia' pagata dal sink alla treasury a ogni flush
  perpOpen: false,
  lighterAccountIndex: null,   // account Lighter = sub-wallet su 4663
  lighterApiPrivKey: null,     // chiave API Lighter della coin, CIFRATA (enc:…)
  lighterApiKeyIndex: null,
  lighterLeverage: null,        // leverage last set successfully on Lighter (null = never; legacy
                               // `lighterLeverageSet: true` is read by the keeper as the launch leverage)
  engineBlocked: null,         // why the engine takes no new exposure (leverage above the venue cap), or null
  perpEngine: null,            // {market, side} the open tranches belong to (managed coins)
  perpSwitch: null,            // {from:{market,side}, to:{market,side}, since}: closing the old position, or null
  perpDust: {},                // market id → size of a leftover the venue refused to close for being too small
  perpDepositedUsd: 0,         // USDG cumulativi mandati a Lighter come collaterale
  perpTrancheAt: 0,            // when the last tranche was opened whole (ms)
  perpFilling: false,          // the last opening filled in part: the rest goes in without waiting
  perpCarry: false,            // what the account holds is the capital of the engine before a switch
  perpOrder: null,             // the order in flight, written before it is sent and settled on its trades (internal)
  perpWithdrawCashUsd: null,   // the cash before the withdrawal in flight (null = none, or from before this existed)
  perpWithdrawTx: null,        // its transaction on the venue, when known
  perpDepositUsd: 0,           // how much the last deposit was
  surplusSeen: null,           // a surplus waiting to be seen again before it is believed: { raw, at }
  shortSince: 0,               // since when the wallet holds less than the books say (ms)
  perpWithdrawAt: 0,           // when it was sent (ms)
  perpWithdrawWas: null,       // what the books held before it
  perpDepositAt: 0,            // when the last deposit was sent (ms)
  perpHwmUsd: 0,               // (legacy, non piu' usato dal TP a tranche)
  perpTranches: [],            // tranche aperte: {base, entryMark, collateralUsd, sizeDec, ts, leverage}
  perpRealizedUsd: 0,          // profitto realizzato su Lighter, non ancora prelevato
  perpCapitalUsd: 0,           // collateral of the tranches that took profit, out of the engine, not yet withdrawn
  perpFundingUsd: 0,           // funding cumulativo (negativo = pagato), solo statistica: sta nel margine
  perpFundingSeen: {},         // baseline per mercato di total_funding_paid_out (interno)
  perpWithdrawIntentProfitUsd: 0,  // of the intent, the part that is profit (the protocol's share is taken on it alone)
  perpWithdrawPendingProfitUsd: 0, // same, of the pending
  perpWithdrawIntentUsd: 0,    // write-ahead: withdraw richiesto ma esito non confermato
  perpWithdrawPendingUsd: 0,   // prelevato da Lighter, in arrivo sul sub-wallet
  perpWithdrawBlock: null,     // blocco di inizio finestra withdraw (match dei log)
  perpWithdrawScanBlock: null, // ultimo blocco scansionato per il credito del bridge
  txOut: null,                 // a transfer out of the sub-wallet not yet known: bucket, amount, signed transaction
  perpLookAt: 0,               // when the perp half last ran to its end (ms)
  lastTickTs: 0,
};

/** a token's state from nothing: its own arrays and objects, never the ones of the defaults */
const freshState = () => structuredClone(STATE_DEFAULTS);

function load() {
  if (!fs.existsSync(config.REGISTRY_PATH)) return { coins: [], state: {} };
  const reg = JSON.parse(fs.readFileSync(config.REGISTRY_PATH, 'utf8'));
  reg.coins = reg.coins || [];
  reg.state = reg.state || {};
  for (const c of reg.coins) {
    const k = c.token.toLowerCase();
    const old = reg.state[k] || {};
    reg.state[k] = { ...freshState(), ...old };
    // withdrawals on their way from before capital left too were all profit
    if (old.perpWithdrawPendingProfitUsd === undefined) reg.state[k].perpWithdrawPendingProfitUsd = Number(old.perpWithdrawPendingUsd || 0);
    if (old.perpWithdrawIntentProfitUsd === undefined) reg.state[k].perpWithdrawIntentProfitUsd = Number(old.perpWithdrawIntentUsd || 0);
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
          reg.state[k] = { ...freshState(), ...((disk.state || {})[k] || {}) };
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
  reg.state[coin.token.toLowerCase()] = freshState();
  return reg;
}

module.exports = { load, save, addCoin, freshState, STATE_DEFAULTS };
