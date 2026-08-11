const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const config = require('./config');
const { provider, erc20, tokenMeta, gasPrice } = require('./lib/chain');
const { deriveSubWallet, checkFingerprint } = require('./lib/subwallet');
const { buildLaunchPlan, npmIface, SPACING_BY_FEE } = require('./lib/v3');
const registry = require('./lib/registry');

/**
 * launchCoin.js — lancio perpspad completo su Robinhood Chain
 *
 * Pipeline (stile perpspad, rails launchDirect):
 *   1. deploy PerpsPadToken (supply fissa al deployer, burn() pubblica)
 *   2. sub-wallet della coin derivato HMAC dal master secret (solo address su disco)
 *   3. pool V3 one-sided: createAndInitializePoolIfNecessary + mint in una multicall,
 *      TUTTA la supply nel range, prezzo iniziale sul bordo (parametri pons)
 *   4. LP NFT → PerpsPadLocker via safeTransferFrom con data=abi.encode(subWallet):
 *      lock PERMANENTE, fee claimabili da chiunque ma SOLO verso il sub-wallet
 *   5. coin registrata nel registry: da li' in poi ci pensa keeper.js
 *
 * Uso:
 *   node launchCoin.js --name "Nome Coin" --symbol SYM [--supply 1000000000]
 *                      [--pair 0x…] [--fee 10000] [--mcap 1.3557]
 *                      [--creator 0x…] [--market BTC --side long --lev 3] [--dry]
 *
 *   --pair    default USDG (quote in dollari → gate USD esatti); qualsiasi ERC20
 *             (stock token compresi) e' supportato, ma serve PERPSPAD_PRICE_<SYM>
 *   --creator default: il deployer. E' SOLO una destinazione payout (15%)
 *   --market/--side/--lev: il sottostante perp (fase Lighter; per ora registrato)
 *   --dry     stampa il piano senza inviare nulla
 *
 * Ripresa: se un run muore a meta', rilanciare con --token 0x… salta il deploy
 * e riprende dallo step mancante (pool → lock → registry). Idempotente per step.
 */

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes('--' + name);

function requireDeployer() {
  if (!config.DEPLOYER_KEY) throw new Error('DEPLOYER_PRIVATE_KEY/LAUNCHER_PRIVATE_KEY mancante nel .env');
  return new ethers.Wallet(config.DEPLOYER_KEY, provider);
}

async function deployToken(deployer, name, symbol, supplyStr) {
  const art = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'contracts', 'PerpsPadToken.json'), 'utf8'));
  const supply = ethers.utils.parseUnits(supplyStr, 18);
  console.log(`deploy PerpsPadToken "${name}" (${symbol}) supply ${supplyStr}…`);
  const f = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
  const c = await f.deploy(name, symbol, supply, { gasPrice: await gasPrice(), type: 0 });
  console.log('  tx', c.deployTransaction.hash);
  await c.deployed();
  console.log('  ✓ token', c.address);
  return c.address;
}

async function getPool(token, pair, fee) {
  const iface = new ethers.utils.Interface(['function getPool(address,address,uint24) view returns (address)']);
  const out = await provider.call({ to: config.V3_FACTORY, data: iface.encodeFunctionData('getPool', [token, pair, fee]) });
  return ethers.utils.getAddress('0x' + out.slice(26));
}

// slot0.tick del pool (per capire a che prezzo e' stato inizializzato — M1)
async function poolTick(pool) {
  const iface = new ethers.utils.Interface(['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)']);
  const out = await provider.call({ to: pool, data: iface.encodeFunctionData('slot0', []) });
  return iface.decodeFunctionResult('slot0', out).tick;
}

// H2 — l'NFT LP e' DAVVERO la posizione di questa coin? (token0/token1/fee giusti,
// liquidita' > 0). Senza questo check un --lp sbagliato lockerebbe l'NFT del pool
// errato, lasciando libera la LP vera — garanzia di lock rotta in modo invisibile.
async function assertLpMatches(npm, lpTokenId, token, pair, fee) {
  const p = await npm.positions(lpTokenId);
  const set = new Set([p.token0.toLowerCase(), p.token1.toLowerCase()]);
  if (!set.has(token.toLowerCase()) || !set.has(pair.toLowerCase()) || Number(p.fee) !== Number(fee)) {
    throw new Error(`LP NFT ${lpTokenId} NON e' la posizione di questa coin (token0=${p.token0} token1=${p.token1} fee=${p.fee}); atteso ${token}/${pair} fee ${fee}`);
  }
  if (p.liquidity.isZero()) throw new Error(`LP NFT ${lpTokenId} ha liquidita' 0`);
}

async function main() {
  const dry = flag('dry');
  const deployer = requireDeployer();
  if (!config.LOCKER) throw new Error('PERPSPAD_LOCKER mancante: deploya prima il locker (node deployLocker.js)');
  if (!config.MASTER_SECRET) throw new Error('PERPSPAD_MASTER_SECRET mancante nel .env');
  checkFingerprint(); // H3: il master secret e' quello di sempre? altrimenti ABORT prima di lockare

  const pair = ethers.utils.getAddress(arg('pair', config.USDG));
  const fee = Number(arg('fee', String(config.DEFAULT_POOL_FEE)));
  const spacing = SPACING_BY_FEE[fee];
  if (!spacing) throw new Error('fee tier non supportata: ' + fee);

  // 1) token: --token per riprendere un lancio a meta', altrimenti deploy
  let token = arg('token', null);
  if (!token) {
    const name = arg('name'), symbol = arg('symbol');
    if (!name || !symbol) throw new Error('servono --name e --symbol (o --token 0x… per riprendere)');
    if (dry) { console.log(`--dry: deployerei "${name}" (${symbol}) e lancerei su pair ${pair}`); }
    token = dry ? ethers.constants.AddressZero : await deployToken(deployer, name, symbol, arg('supply', config.DEFAULT_SUPPLY));
    if (dry) return;
  }
  token = ethers.utils.getAddress(token);
  const [tMeta, pMeta] = await Promise.all([tokenMeta(token), tokenMeta(pair)]);
  const subWallet = deriveSubWallet(token, provider);
  const creator = ethers.utils.getAddress(arg('creator', deployer.address));

  console.log('=== LANCIO PERPSPAD ===');
  console.log(` token      : ${token} "${tMeta.name}" (${tMeta.symbol})`);
  console.log(` pair       : ${pair} (${pMeta.symbol}, ${pMeta.decimals} dec)  fee ${fee}`);
  console.log(` sub-wallet : ${subWallet.address} (derivato HMAC, chiave solo in-process)`);
  console.log(` creator    : ${creator}  | locker ${config.LOCKER}`);

  // 2) pool one-sided (skip se gia' esistente = ripresa)
  let pool = await getPool(token, pair, fee);
  let lpTokenId = null;
  const npm = new ethers.Contract(config.POSITION_MANAGER, npmIface, deployer);
  if (pool === ethers.constants.AddressZero) {
    const bal = await erc20(token).balanceOf(deployer.address);
    if (bal.isZero()) throw new Error('il deployer non ha supply del token');
    const mcapRaw = ethers.utils.parseUnits(arg('mcap', config.DEFAULT_MCAP_USD), pMeta.decimals);
    const plan = buildLaunchPlan({ token, pair, fee, spacing, supplyRaw: bal, mcapRaw, recipient: deployer.address });
    console.log(` piano      : tick ${plan.tick} range [${plan.tickLower} → ${plan.tickUpper}] one-sided, tutta la supply`);

    // H1 — in --dry il piano si stampa e si ESCE, senza inviare nulla (anche con --token,
    // perche' oltre questo punto ci sono approve/mint/lock IRREVERSIBILI: il locker non ha recovery)
    if (dry) { console.log('\n--dry: niente inviato (mcap/tick/range sopra sono il piano)'); return; }

    const allowance = await erc20(token).allowance(deployer.address, config.POSITION_MANAGER);
    if (allowance.lt(bal)) {
      console.log(' approve token→NPM…');
      const txA = await erc20(token, deployer).approve(config.POSITION_MANAGER, ethers.constants.MaxUint256, { gasPrice: await gasPrice(), type: 0 });
      await txA.wait();
    }
    // L2 — sanita' pre-fire: la multicall passa in simulazione? (front-run, token strano → revert)
    try {
      await provider.call({ from: deployer.address, to: config.POSITION_MANAGER, data: plan.data });
    } catch (e) { throw new Error('la tx di lancio REVERTA in simulazione (pool front-runnato? token con transfer restrittivo?): ' + e.message.slice(0, 160)); }

    console.log(' creo pool + mint (multicall)…');
    const tx = await deployer.sendTransaction({ to: config.POSITION_MANAGER, data: plan.data, gasLimit: 7000000, gasPrice: await gasPrice(), type: 0 });
    console.log('  tx', tx.hash);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error('lancio revertato');
    const t = rc.logs.find((l) => l.address.toLowerCase() === config.POSITION_MANAGER.toLowerCase()
      && l.topics[0] === ethers.utils.id('Transfer(address,address,uint256)') && ethers.BigNumber.from(l.topics[1]).isZero());
    if (!t) throw new Error('lancio confermato ma Transfer del LP NFT non trovato nella ricevuta: ripassa con --token e --lp <tokenId> dopo aver letto il tokenId da explorer');
    lpTokenId = ethers.BigNumber.from(t.topics[3]).toString();
    pool = await getPool(token, pair, fee);
    console.log(`  ✓ pool ${pool}  LP NFT ${lpTokenId}`);
  } else {
    // M1 — pool gia' esistente: puo' essere una ripresa NOSTRA o un pool creato da un
    // terzo (factory permissionless, CA pubblica dopo il deploy). Distinguiamo dal tick.
    const mcapRaw = ethers.utils.parseUnits(arg('mcap', config.DEFAULT_MCAP_USD), pMeta.decimals);
    const bal = await erc20(token).balanceOf(deployer.address);
    const expected = buildLaunchPlan({ token, pair, fee, spacing, supplyRaw: bal.isZero() ? mcapRaw : bal, mcapRaw, recipient: deployer.address });
    const tick = await poolTick(pool);
    const atOurTick = Math.abs(Number(tick) - expected.tick) <= spacing;
    console.log(` pool       : ${pool} gia' esistente (tick ${tick}, atteso ~${expected.tick}) — ${atOurTick ? 'coerente col nostro lancio (ripresa)' : '⚠️  NON al nostro tick: forse creato da un TERZO'}`);
    if (!atOurTick && !flag('force')) throw new Error('il pool esiste ma NON e\' al tick previsto: potrebbe averlo creato un front-runner. Verifica su explorer; se e\' comunque tuo, riprova con --lp <tokenId> --force');
  }

  // 3) lock: NFT → locker con il sub-wallet nei data (skip se gia' fatto)
  const locker = new ethers.Contract(config.LOCKER, [
    'function feeRecipient(uint256) view returns (address)',
    'function collect(uint256) returns (uint256,uint256)',
  ], provider);
  if (!lpTokenId) {
    // ripresa: l'ultimo NFT del deployer su questo pool — piu' semplice chiederlo
    lpTokenId = arg('lp', null);
    if (!lpTokenId) throw new Error('pool esistente ma LP NFT ignoto: ripassa con --lp <tokenId>');
  }
  const registered = await locker.feeRecipient(lpTokenId);
  if (registered === ethers.constants.AddressZero) {
    const owner = await npm.ownerOf(lpTokenId);
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`LP NFT ${lpTokenId} non e' del deployer (owner ${owner})`);
    await assertLpMatches(npm, lpTokenId, token, pair, fee); // H2: e' davvero la posizione di QUESTA coin
    if (dry) { console.log(`\n--dry: lockerei il tokenId ${lpTokenId} → ${subWallet.address} (non inviato)`); return; }
    console.log(' lock LP NFT → locker (permanente)…');
    const data = ethers.utils.defaultAbiCoder.encode(['address'], [subWallet.address]);
    const txL = await npm['safeTransferFrom(address,address,uint256,bytes)'](deployer.address, config.LOCKER, lpTokenId, data, { gasLimit: 300000, gasPrice: await gasPrice(), type: 0 });
    console.log('  tx', txL.hash);
    const rcL = await txL.wait();
    if (rcL.status !== 1) throw new Error('lock revertato');
    console.log(`  ✓ lockato: fee del tokenId ${lpTokenId} → ${subWallet.address}, per sempre`);
  } else {
    console.log(` lock       : gia' registrato → ${registered}`);
    if (registered.toLowerCase() !== subWallet.address.toLowerCase()) throw new Error('feeRecipient registrato DIVERSO dal sub-wallet derivato: master secret cambiato?');
  }

  // 4) registry
  const reg = registry.load();
  registry.addCoin(reg, {
    token, name: tMeta.name, symbol: tMeta.symbol,
    pair, pairSymbol: pMeta.symbol, pairDecimals: pMeta.decimals,
    fee, pool, lpTokenId,
    subWallet: subWallet.address, creator,
    market: arg('market', 'BTC'), side: arg('side', 'long'), leverage: Number(arg('lev', '3')),
    createdAt: new Date().toISOString(),
  });
  registry.save(reg);
  console.log(`\n✓ COIN REGISTRATA nel registry (${reg.coins.length} totali) — il keeper la prende al prossimo tick`);
}

main().catch((e) => { console.error('\nErrore:', e.message); process.exit(1); });
