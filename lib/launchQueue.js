const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/**
 * launchQueue.js — coda delle richieste di REGISTRAZIONE.
 *
 * Nel lancio permissionless l'utente fa da se' le transazioni che costano: il
 * deploy del token (bytecode canonico), la creazione del pool con il mint
 * one-sided, e il transfer dell'LP al locker con dentro l'indirizzo del
 * sub-wallet — che e' informazione pubblica, e l'operatore la espone in lettura.
 * Al keeper resta solo l'ultimo passo: verificare on-chain che tutto sia in
 * regola e registrare la coin, cioe' iniziare a servirla.
 *
 * Il sito quindi non ha bisogno di chiavi e il deployer non spende gas: sparisce
 * del tutto il vettore "qualcuno mi svuota l'ETH lanciando a raffica". Resta un
 * costo operativo per coin servita (gas dei sub-wallet, RPC a ogni tick): e' cio'
 * che la fee di lancio copre, ed e' il motivo per cui la registrazione non e'
 * gratuita ne' automatica.
 *
 * Il job porta il tx-hash del pagamento, che NON e' la prova: la verifica
 * on-chain la fa il keeper. Qui si garantisce solo che lo stesso pagamento non
 * possa registrare due coin.
 *
 * Scrittura atomica (tmp+rename) come il registry: un crash a meta' scrittura
 * non lascia mai un job illeggibile.
 */

const QUEUE_DIR = process.env.PERPSPAD_LAUNCH_QUEUE_DIR
  || path.resolve(path.dirname(config.REGISTRY_PATH), 'launch-queue');

// un job "running" di un keeper morto tornerebbe prenotabile all'infinito: dopo
// questa finestra si puo' riprendere, e il progresso salvato (token, lpTokenId)
// fa riprendere il lancio invece di rideployare.
const STALE_CLAIM_MS = 10 * 60_000;

const STATES = ['pending', 'running', 'done', 'failed'];

function dir(base) { return base || QUEUE_DIR; }

function ensureDir(base) {
  const d = dir(base);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function jobPath(id, base) { return path.join(dir(base), `${id}.json`); }

function writeAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

function read(id, base) {
  try { return JSON.parse(fs.readFileSync(jobPath(id, base), 'utf8')); }
  catch { return null; }
}

function all(base) {
  const d = dir(base);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Accoda un lancio. `params` deve essere gia' passato da validateLaunchParams:
 * qui non si rivalida, si rifiuta solo il riuso di un pagamento.
 */
function enqueue({ params, feeTxHash, now = Date.now() }, base) {
  ensureDir(base);
  const hash = String(feeTxHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('feeTxHash non valido');
  const dup = all(base).find((j) => j.feeTxHash === hash);
  if (dup) throw new Error(`pagamento gia' usato dal job ${dup.id}`);

  const job = {
    id: crypto.randomUUID(),
    state: 'pending',
    params,
    feeTxHash: hash,
    createdAt: now,
    claimedAt: null,
    attempts: 0,
    // progresso: permette la ripresa invece di rideployare un token gia' esistente
    progress: { token: null, lpTokenId: null, step: null },
    error: null,
  };
  writeAtomic(jobPath(job.id, base), job);
  return job;
}

/** i job che il keeper puo' prendere in carico, dal piu' vecchio */
function claimable(now = Date.now(), base) {
  return all(base)
    .filter((j) => j.state === 'pending'
      || (j.state === 'running' && now - (j.claimedAt || 0) > STALE_CLAIM_MS))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Prende in carico un job. Ritorna null se nel frattempo e' stato preso o
 * concluso: l'esecutore deve trattarlo come "non mio" e passare oltre.
 */
function claim(id, now = Date.now(), base) {
  const job = read(id, base);
  if (!job) return null;
  const fresco = job.state === 'pending';
  const scaduto = job.state === 'running' && now - (job.claimedAt || 0) > STALE_CLAIM_MS;
  if (!fresco && !scaduto) return null;
  job.state = 'running';
  job.claimedAt = now;
  job.attempts += 1;
  writeAtomic(jobPath(id, base), job);
  return job;
}

/** salva il progresso parziale: e' cio' che rende ripetibile un lancio interrotto */
function progress(id, patch, base) {
  const job = read(id, base);
  if (!job) return null;
  job.progress = { ...job.progress, ...patch };
  writeAtomic(jobPath(id, base), job);
  return job;
}

function finish(id, { token }, base) {
  const job = read(id, base);
  if (!job) return null;
  job.state = 'done';
  job.error = null;
  job.progress = { ...job.progress, token: token || job.progress.token };
  job.finishedAt = Date.now();
  writeAtomic(jobPath(id, base), job);
  return job;
}

function fail(id, reason, base) {
  const job = read(id, base);
  if (!job) return null;
  job.state = 'failed';
  job.error = String(reason || '').slice(0, 300);
  job.finishedAt = Date.now();
  writeAtomic(jobPath(id, base), job);
  return job;
}

/** vista pubblica: mai il tx della fee ne' dettagli interni verso il browser */
function publicView(job) {
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    symbol: job.params?.symbol ?? null,
    token: job.progress?.token ?? null,
    step: job.progress?.step ?? null,
    error: job.state === 'failed' ? job.error : null,
    createdAt: job.createdAt,
  };
}

module.exports = {
  enqueue, claim, claimable, progress, finish, fail, read, all, publicView,
  QUEUE_DIR, STALE_CLAIM_MS, STATES,
};
