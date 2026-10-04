const fs = require('fs');
const path = require('path');
const config = require('../config');

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
  'perpOpen', 'perpCollateralUsd', 'perpDepositedUsd', 'perpRealizedUsd', 'perpFundingUsd',
  'perpWithdrawPendingUsd', 'perpTranches', 'lighterAccountIndex', 'lastTickTs',
];

const SNAPSHOT_PATH = path.join(config.STATE_DIR, 'public.json');

function publicSnapshot(reg) {
  const state = {};
  for (const [token, st] of Object.entries(reg.state || {})) {
    const pub = {};
    for (const f of PUBLIC_STATE_FIELDS) if (st[f] !== undefined) pub[f] = st[f];
    state[token] = pub;
  }
  // l'anagrafica e' interamente pubblica: sono indirizzi on-chain verificabili
  return { updatedAt: Date.now(), coins: reg.coins || [], state };
}

/** scrittura atomica (tmp+rename): il sito non legge mai un JSON a meta' */
function writeSnapshot(reg) {
  try {
    const snap = publicSnapshot(reg);
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

module.exports = { publicSnapshot, writeSnapshot, PUBLIC_STATE_FIELDS, SNAPSHOT_PATH };
