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
 *                   tiene solo la ripartizione nei bucket (perp/buyback/treasury/
 *                   creator) e gli high-water mark. Se il file si perde, i fondi
 *                   restano nei sub-wallet (derivabili dal master secret) ma la
 *                   ripartizione va ricostruita dagli eventi Collected on-chain.
 *
 * Scrittura atomica (tmp+rename): un crash a meta' tick non corrompe il file.
 */

function load() {
  if (!fs.existsSync(config.REGISTRY_PATH)) return { coins: [], state: {} };
  return JSON.parse(fs.readFileSync(config.REGISTRY_PATH, 'utf8'));
}

function save(reg) {
  const dir = path.dirname(config.REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = config.REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 1));
  fs.renameSync(tmp, config.REGISTRY_PATH);
}

function addCoin(reg, coin) {
  if (reg.coins.some((c) => c.token.toLowerCase() === coin.token.toLowerCase())) {
    throw new Error('coin gia' + "' registrata: " + coin.token);
  }
  reg.coins.push(coin);
  reg.state[coin.token.toLowerCase()] = {
    perpReserveRaw: '0',     // quota 50% in attesa del gate/top-up perp (nel quote)
    buybackReserveRaw: '0',  // quota 15% in attesa del floor $25 (nel quote)
    treasuryOwedRaw: '0',    // quota 20% da girare alla treasury (nel quote)
    creatorOwedRaw: '0',     // quota 15% sotto il minimo $1 (nel quote)
    totalCollected0: '0',    // fee claimate cumulative lato token0
    totalCollected1: '0',
    totalBurnedRaw: '0',     // coin bruciate cumulative
    perpOpen: false,         // stato posizione (fase Lighter)
    perpCollateralUsd: 0,
    // ── stato Lighter per la coin (fase 2) ──────────────────────────────────
    lighterAccountIndex: null,   // account Lighter = sub-wallet su 4663 (risolto dopo il 1o deposito)
    lighterApiPrivKey: null,     // chiave API Lighter della coin (ordini); NON puo' prelevare verso terzi
    lighterApiKeyIndex: null,
    lighterLeverageSet: false,
    perpDepositedUsd: 0,         // USDG cumulativi mandati a Lighter come collaterale
    perpPendingDepositUsd: 0,    // depositati ma non ancora visti accreditati
    perpHwmUsd: 0,               // high-water mark del PnL per il take-profit a scaglioni
    perpRealizedUsd: 0,          // profitto realizzato su Lighter, non ancora prelevato
    perpWithdrawPendingUsd: 0,   // prelevato da Lighter, in arrivo sul sub-wallet (da riconciliare)
    lastTickTs: 0,
  };
  return reg;
}

module.exports = { load, save, addCoin };
