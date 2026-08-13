const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const config = require('./config');
const { provider, gasPrice } = require('./lib/chain');

/**
 * deployLocker.js — deploy one-shot del MultiplyLocker (NPM nel constructor).
 *
 * Il locker e' UNO per tutto il launchpad: senza owner e senza upgrade, una volta
 * deployato non si tocca piu'. L'address finisce in state/locker.deployed.json
 * e va copiato nel .env come PERPSPAD_LOCKER.
 *
 * Uso: node deployLocker.js [--dry]
 */

async function main() {
  const dry = process.argv.includes('--dry');
  if (config.LOCKER) console.log(`ATTENZIONE: PERPSPAD_LOCKER gia' settato (${config.LOCKER}) — un secondo deploy crea un locker NUOVO e separato`);
  if (!config.DEPLOYER_KEY) throw new Error('DEPLOYER_PRIVATE_KEY/LAUNCHER_PRIVATE_KEY mancante nel .env');
  const deployer = new ethers.Wallet(config.DEPLOYER_KEY, provider);
  const art = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'contracts', 'MultiplyLocker.json'), 'utf8'));
  console.log(`deploy MultiplyLocker(NPM ${config.POSITION_MANAGER}) da ${deployer.address}…`);
  if (dry) { console.log('--dry: non inviato'); return; }
  const f = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
  const c = await f.deploy(config.POSITION_MANAGER, { gasPrice: await gasPrice(), type: 0 });
  console.log('  tx', c.deployTransaction.hash);
  await c.deployed();
  const out = { locker: c.address, npm: config.POSITION_MANAGER, deployer: deployer.address, tx: c.deployTransaction.hash, chainId: config.CHAIN_ID, at: new Date().toISOString() };
  const p = path.resolve(__dirname, 'state', 'locker.deployed.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 1));
  console.log(`\n✓ LOCKER: ${c.address}`);
  console.log(`  aggiungi al .env:  PERPSPAD_LOCKER=${c.address}`);
}

main().catch((e) => { console.error('Errore:', e.message); process.exit(1); });
