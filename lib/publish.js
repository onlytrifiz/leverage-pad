const fs = require('fs');
const path = require('path');
const config = require('../config');
const { publicFlywheel } = require('./flywheel');

/**
 * publish.js — snapshot PUBBLICO del registry, per il sito.
 *
 * Il registry vero contiene la chiave API Lighter di ogni coin (cifrata, ma non
 * c'e' motivo di esporla) e stato interno del keeper. Il sito in produzione gira
 * su un host remoto e non puo' leggere il file locale: pubblichiamo un estratto.
 *
 * WHITELIST, non blacklist: un campo nuovo — magari un segreto aggiunto domani —
 * NON finisce pubblico per dimenticanza. Se il sito ha bisogno di un dato in piu',
 * lo si aggiunge qui consapevolmente.
 */

const PUBLIC_STATE_FIELDS = [
  'perpReserveRaw', 'buybackReserveRaw', 'treasuryOwedRaw', 'creatorOwedRaw',
  'totalCollected0', 'totalCollected1', 'totalBurnedRaw', 'sinkTreasuryRaw',
  'perpOpen', 'perpDepositedUsd', 'perpRealizedUsd', 'perpCapitalUsd', 'perpFundingUsd',
  'perpWithdrawPendingUsd', 'perpWithdrawPendingProfitUsd', 'perpTranches', 'lighterAccountIndex', 'lastTickTs',
  // the engine as the venue runs it: the leverage actually set, and why no new exposure is taken
  // (the coin's own takeProfitPct, managed and pendingEngine are on the coin record, public)
  'lighterLeverage', 'engineBlocked',
  // a managed coin whose market or side changed: what is still being closed
  'perpSwitch',
  // the tranches that are over: how each one ended (lib/closed.js)
  'perpClosed',
];

const SNAPSHOT_PATH = path.join(config.STATE_DIR, 'public.json');
// what lib/health.js found: for /alerts only, not part of the public snapshot
const HEALTH_PATH = path.join(config.STATE_DIR, 'health.json');

/** `viewOf(account)`: the last read of a Lighter account */
function publicSnapshot(reg, { viewOf = () => null } = {}) {
  const state = {};
  for (const [token, st] of Object.entries(reg.state || {})) {
    const pub = {};
    for (const f of PUBLIC_STATE_FIELDS) if (st[f] !== undefined) pub[f] = st[f];
    const view = viewOf(st.lighterAccountIndex);
    if (view) pub.perpView = view;
    state[token] = pub;
  }
  // l'anagrafica e' interamente pubblica: sono indirizzi on-chain verificabili
  return { updatedAt: Date.now(), coins: reg.coins || [], state, flywheel: publicFlywheel(reg.flywheel) };
}

/** scrittura atomica (tmp+rename): il sito non legge mai un JSON a meta' */
function writeSnapshot(reg, extras) {
  try {
    const snap = publicSnapshot(reg, extras);
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const tmp = SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, SNAPSHOT_PATH);
    return SNAPSHOT_PATH;
  } catch (e) {
    console.log(`  snapshot pubblico non scritto: ${e.message.slice(0, 80)}`);
    return null;
  }
}

function writeHealth(health, file = HEALTH_PATH) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(health));
  fs.renameSync(tmp, file);
}

module.exports = { publicSnapshot, writeSnapshot, writeHealth, PUBLIC_STATE_FIELDS, SNAPSHOT_PATH, HEALTH_PATH };
