const crypto = require('crypto');
const config = require('../config');

/**
 * secrets.js — cifratura at-rest dei segreti a raggio ristretto nel registry
 * (oggi: la chiave API Lighter per-coin). AES-256-GCM con chiave derivata dal
 * master secret: chi ha SOLO il file registry non puo' usare le API key; chi ha
 * il master secret poteva gia' tutto (deriva i sub-wallet), quindi non si
 * aggiunge nessun nuovo single point of failure.
 *
 * Formato: "enc:<iv hex>:<authTag hex>:<ciphertext hex>". decryptSecret accetta
 * anche valori in chiaro (migrazione: il keeper ri-cifra al primo passaggio).
 */

function encKey() {
  if (!config.MASTER_SECRET) throw new Error('PERPSPAD_MASTER_SECRET mancante: impossibile cifrare/decifrare i segreti');
  return crypto.createHmac('sha256', config.MASTER_SECRET).update('multiply:apikey:enc:v1').digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'enc:' + iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + data.toString('hex');
}

function decryptSecret(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value; // legacy in chiaro
  const [, ivHex, tagHex, dataHex] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

const isEncrypted = (value) => typeof value === 'string' && value.startsWith('enc:');

module.exports = { encryptSecret, decryptSecret, isEncrypted };
