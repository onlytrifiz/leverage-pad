const crypto = require('crypto');
const { ethers } = require('ethers');
const config = require('../config');

/**
 * subwallet.js — derivazione deterministica dei sub-wallet per coin
 *
 * Stessa idea del paper perpspad: privkey = HMAC-SHA256(masterSecret, coinId).
 * La chiave esiste solo nel processo keeper, mai su disco: dal registry si salva
 * SOLO l'address. coinId = address del token in lowercase, quindi la derivazione
 * e' riproducibile da chiunque abbia il master secret anche perdendo il registry.
 *
 * NOTA curva: l'output HMAC e' un uint256; la probabilita' che esca fuori
 * dall'ordine di secp256k1 e' ~2^-128, ma per non lasciare il caso teorico si
 * itera con un contatore finche' la chiave e' valida.
 */

function deriveSubWallet(coinId, provider) {
  if (!config.MASTER_SECRET) throw new Error('PERPSPAD_MASTER_SECRET mancante nel .env');
  const id = String(coinId).toLowerCase();
  for (let ctr = 0; ctr < 256; ctr++) {
    const key = crypto.createHmac('sha256', config.MASTER_SECRET)
      .update(ctr === 0 ? id : id + ':' + ctr)
      .digest();
    try {
      const w = new ethers.Wallet('0x' + key.toString('hex'));
      return provider ? w.connect(provider) : w;
    } catch { /* chiave fuori curva: ritenta col contatore */ }
  }
  throw new Error('derivazione sub-wallet fallita per ' + coinId);
}

// H3 — fingerprint del master secret: address stabile derivato dal probe.
// Se cambia (secret diverso/troncato/rigenerato), i sub-wallet cambiano e le fee
// gia' lockate diventerebbero irraggiungibili → si deve ABORTIRE, non incidere
// un feeRecipient nuovo. checkFingerprint scrive il file al primo uso e poi
// pretende che combaci, sia a lancio che all'avvio del keeper.
const fs = require('fs');
const path = require('path');

function fingerprint() {
  return deriveSubWallet(config.FINGERPRINT_PROBE).address;
}

function checkFingerprint() {
  const fp = fingerprint();
  const p = config.FINGERPRINT_PATH;
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ fingerprint: fp, at: new Date().toISOString() }, null, 1));
    console.log(`fingerprint master secret registrato: ${fp}`);
    return fp;
  }
  const saved = JSON.parse(fs.readFileSync(p, 'utf8')).fingerprint;
  if (saved.toLowerCase() !== fp.toLowerCase()) {
    throw new Error(`MASTER_SECRET DIVERSO da quello registrato (fingerprint ${fp} != ${saved}): i sub-wallet non combacerebbero, ABORT. Ripristina il secret originale o cancella ${p} solo se sai cosa fai.`);
  }
  return fp;
}

module.exports = { deriveSubWallet, fingerprint, checkFingerprint };
