const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * stateSeed.js — first boot of the keeper on a fresh volume.
 *
 * The registry carries the keeper's accounting (perp reserves, tranches, withdraw windows,
 * the encrypted Lighter API keys) and cannot be rebuilt from the chain alone. When the keeper
 * moves to a new host, PERPSPAD_STATE_SEED carries the files it had: base64 of
 * `{"files": {"registry.json": "<contents>", "fingerprint.json": "<contents>"}}`.
 *
 * A seed only ever CREATES a missing file. If the volume already has a registry, the seed is
 * ignored: a redeploy with a stale seed left in the environment must never roll the accounting
 * back to the day of the move. Only plain file names are accepted, written atomically.
 */

const SEEDABLE = new Set(['registry.json', 'fingerprint.json']);

function parseSeed(b64) {
  const obj = JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'));
  const files = obj && typeof obj === 'object' ? obj.files : null;
  if (!files || typeof files !== 'object') throw new Error('PERPSPAD_STATE_SEED: expected {"files": {...}}');
  for (const [name, content] of Object.entries(files)) {
    if (!SEEDABLE.has(name)) throw new Error(`PERPSPAD_STATE_SEED: ${name} is not a seedable state file`);
    if (typeof content !== 'string') throw new Error(`PERPSPAD_STATE_SEED: ${name} must be a string`);
    JSON.parse(content); // must be valid JSON before it can land on the volume
  }
  return files;
}

/** writes the seed's files that do not exist yet; returns { written, skipped } */
function applySeed(b64, dir = config.STATE_DIR, log = console.log) {
  if (!b64) return { written: [], skipped: [] };
  const files = parseSeed(b64);
  fs.mkdirSync(dir, { recursive: true });
  const written = [], skipped = [];
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (fs.existsSync(target)) { skipped.push(name); continue; }
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
    written.push(name);
  }
  if (written.length) log(`state seed: wrote ${written.join(', ')} to ${dir}`);
  if (skipped.length) log(`state seed: ${skipped.join(', ')} already on the volume, seed ignored for them (remove PERPSPAD_STATE_SEED)`);
  return { written, skipped };
}

module.exports = { parseSeed, applySeed, SEEDABLE };
