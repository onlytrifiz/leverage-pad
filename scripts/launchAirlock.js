const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const config = require('../config');
const { provider, gasPrice } = require('../lib/chain');
const { deriveSubWallet, checkFingerprint } = require('../lib/subwallet');

/**
 * launchAirlock.js — launch a coin through long.xyz's Doppler Airlock on Robinhood Chain.
 *
 * Airlock.create() is permissionless: no LongLaunchFactory signature needed. The coin is a
 * DopplerERC20V1 (no mint, real burn()), the pool is Uniswap v4 with the DopplerHookInitializer
 * as hook, locked by beneficiaries. Fee design:
 *   - LP fee = 0. The trading fee is the Rehype hook fee, always attached, so it lands in USDG:
 *     coin-side fees (buys) are swapped to USDG inside the hook, USDG-side fees (sells) pass through,
 *     everything goes to buybackDst (the sub-wallet). Doppler keeps 5% of the hook fee.
 *   - --snipe: opening fee 80% decaying to the trading fee over SNIPE_SECS; without it, flat.
 *   - --dev-buy <usdg>: launch through Doppler's Bundler, which buys in the same call frame; the Rehype
 *     exempts that one swap from the anti-snipe fee (the 5% Doppler slice of it still applies).
 *
 * Two passes: the token address depends only on the salt, so a first eth_call with a placeholder
 * beneficiary returns it; the sub-wallet is derived from that address (same convention as the
 * V3 launcher), then the final calldata is simulated again and must yield the same token.
 *
 * Usage: node scripts/launchAirlock.js [--name "Test 6"] [--symbol TEST6] [--fee-bps 300] [--snipe]
 *                                       [--mcap 4000] [--dev-buy 5] [--token-uri ipfs://…] [--broadcast]
 *   --token-uri: metadata pinned via the site's /api/metadata (Doppler standard: IPFS JSON with image).
 *   Without it the engine settings go on-chain as a data URI, which terminals do not render.
 * Without --broadcast nothing is sent.
 */

const AIRLOCK = '0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862';
const TOKEN_FACTORY = '0x1B37D3a72082029c44B35B604Ea473617580b69a';
const NOOP_GOVERNANCE = '0x85f37f74Ef2478A770318bc810177a9835911aD7';
const INITIALIZER = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const REHYPE = '0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215'; // official Doppler Rehype (docs.doppler.lol): dev-buy exemption via Bundler
const BUNDLER = '0xf45588e8e0b1df9db9ae7e20ece5726ae931357c';
const NOOP_MIGRATOR = '0xba2F330EDb16cD8056f5988d8CE19BbC63475A0e';
const DOPPLER_SAFE = '0x21E2ce70511e4FE542a97708e89520471DAa7A66'; // airlock.owner() = Doppler protocol multisig: mandatory >= 5% beneficiary

const TICK_SPACING = 200;
const SNIPE_START = 800_000; // Rehype units are 1e6-based: 800_000 = 80%, which is MAX_SWAP_FEE
const SNIPE_SECS = 10;
const WAD = ethers.BigNumber.from(10).pow(18);
const coder = ethers.utils.defaultAbiCoder;

const AIRLOCK_IFACE = new ethers.utils.Interface([
  'function create((uint256 initialSupply,uint256 numTokensToSell,address numeraire,address tokenFactory,bytes tokenFactoryData,address governanceFactory,bytes governanceFactoryData,address poolInitializer,bytes poolInitializerData,address liquidityMigrator,bytes liquidityMigratorData,address integrator,bytes32 salt) params) returns (address asset,address pool,address governance,address timelock,address migrationPool)',
  'function owner() view returns (address)',
]);

const BUNDLER_IFACE = new ethers.utils.Interface([
  'function bundle((uint256 initialSupply,uint256 numTokensToSell,address numeraire,address tokenFactory,bytes tokenFactoryData,address governanceFactory,bytes governanceFactoryData,address poolInitializer,bytes poolInitializerData,address liquidityMigrator,bytes liquidityMigratorData,address integrator,bytes32 salt) createData,(bool permissionlessClaim,uint64 vestingDuration,uint64 cliffDuration) vestingData,uint128 exactAmountIn,address recipient) payable returns (address asset,(address,address,uint24,int24,address) poolKey,address governance,address timelock,uint128 amountOut)',
]);
const ERC20_IFACE = new ethers.utils.Interface(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// one-sided ask ladder, curve expressed "asset as token0" (Multicurve flips it if needed)
function launchTick(supplyRaw, mcapRaw) {
  const price = Number(mcapRaw.toString()) / Number(supplyRaw.toString());
  const tick = Math.round(Math.log(price) / Math.log(1.0001) / TICK_SPACING) * TICK_SPACING;
  const maxTick = Math.floor(887272 / TICK_SPACING) * TICK_SPACING;
  if (tick <= -maxTick || tick >= maxTick) throw new Error(`tick ${tick} out of range`);
  return { tick, maxTick };
}

function buildParams({ name, symbol, tokenURI, supply, numeraire, tick, maxTick, lpFeePips, subWallet, integrator, salt }) {
  const tokenFactoryData = coder.encode(
    ['string', 'string', 'tuple(uint64 cliff,uint64 duration)[]', 'address[]', 'uint256[]', 'uint256[]', 'string', 'uint256', 'uint48', 'address', 'address[]'],
    [name, symbol, [], [], [], [], tokenURI, 0, 0, ethers.constants.AddressZero, []],
  );
  const snipe = process.argv.includes('--snipe');
  const rehypeInit = coder.encode(
    ['tuple(address numeraire,address buybackDst,uint24 startFee,uint24 endFee,uint32 durationSeconds,uint32 startingTime,uint8 feeRoutingMode,tuple(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) fdi,tuple(address beneficiary,uint96 shares)[] feeBeneficiaries)'],
    [{ numeraire, buybackDst: subWallet, startFee: snipe ? SNIPE_START : lpFeePips, endFee: lpFeePips, durationSeconds: snipe ? SNIPE_SECS : 0, startingTime: 0, feeRoutingMode: 0,
       fdi: [0, WAD, 0, 0, 0, WAD, 0, 0], feeBeneficiaries: [] }], // asset fees → swapped to USDG, USDG fees → direct
  );
  const beneficiaries = [
    { beneficiary: DOPPLER_SAFE, shares: WAD.div(20) },
    { beneficiary: subWallet, shares: WAD.mul(95).div(100) },
  ].sort((a, b) => (ethers.BigNumber.from(a.beneficiary).lt(b.beneficiary) ? -1 : 1));
  const poolInitializerData = coder.encode(
    ['tuple(uint24 fee,int24 tickSpacing,int24 farTick,tuple(int24 tickLower,int24 tickUpper,uint16 numPositions,uint256 shares)[] curves,tuple(address beneficiary,uint96 shares)[] beneficiaries,address dopplerHook,bytes onInit,bytes grad)'],
    [{ fee: 0 /* no LP fee: the hook takes the trading fee so it lands in USDG */, tickSpacing: TICK_SPACING, farTick: maxTick - TICK_SPACING, // farTick must be strictly below the top
       curves: [{ tickLower: tick, tickUpper: maxTick, numPositions: 1, shares: WAD }],
       beneficiaries, dopplerHook: REHYPE, onInit: rehypeInit, grad: '0x' }],
  );
  return {
    initialSupply: supply, numTokensToSell: supply, numeraire,
    tokenFactory: TOKEN_FACTORY, tokenFactoryData,
    governanceFactory: NOOP_GOVERNANCE, governanceFactoryData: '0x',
    poolInitializer: INITIALIZER, poolInitializerData,
    liquidityMigrator: NOOP_MIGRATOR, liquidityMigratorData: '0x',
    integrator, salt,
  };
}

async function simulate(from, params) {
  const data = AIRLOCK_IFACE.encodeFunctionData('create', [params]);
  const ret = await provider.call({ from, to: AIRLOCK, data });
  const [asset, pool] = AIRLOCK_IFACE.decodeFunctionResult('create', ret);
  return { data, asset, pool };
}

async function main() {
  const broadcast = process.argv.includes('--broadcast');
  const name = arg('name', 'Test 6');
  const symbol = arg('symbol', 'TEST6');
  const lpFeePips = Number(arg('fee-bps', 300)) * 100; // bps → v4 pips (1e6 = 100%)
  if (lpFeePips < 10_000 || lpFeePips > 50_000) throw new Error('fee must be between 1% and 5% (--fee-bps 100..500)');
  if (!config.DEPLOYER_KEY) throw new Error('DEPLOYER_PRIVATE_KEY missing in .env');
  if (!config.TREASURY) throw new Error('PERPSPAD_TREASURY missing in .env');
  checkFingerprint();

  const deployer = new ethers.Wallet(config.DEPLOYER_KEY, provider);
  const owner = AIRLOCK_IFACE.decodeFunctionResult('owner', await provider.call({ to: AIRLOCK, data: AIRLOCK_IFACE.encodeFunctionData('owner') }))[0];
  if (owner.toLowerCase() !== DOPPLER_SAFE.toLowerCase()) throw new Error(`airlock owner changed: ${owner} — beneficiary minimum would fail, re-check`);

  const supply = ethers.utils.parseUnits(config.DEFAULT_SUPPLY, 18);
  const mcapRaw = ethers.utils.parseUnits(arg('mcap', config.DEFAULT_MCAP_USD), 6); // USDG
  const { tick, maxTick } = launchTick(supply, mcapRaw);
  const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
  const tokenURI = arg('token-uri', '');
  const base = { name, symbol, tokenURI, supply, numeraire: config.USDG, tick, maxTick, lpFeePips, integrator: config.TREASURY, salt };

  // pass 1: token address (depends on salt only) → sub-wallet
  const p1 = await simulate(deployer.address, buildParams({ ...base, subWallet: deployer.address }));
  const sub = deriveSubWallet(p1.asset);
  // pass 2: final calldata, same token expected
  const params = buildParams({ ...base, subWallet: sub.address });
  const p2 = await simulate(deployer.address, params);
  if (p2.asset.toLowerCase() !== p1.asset.toLowerCase()) throw new Error(`token address drifted between passes: ${p1.asset} vs ${p2.asset}`);
  const devBuy = arg('dev-buy', '');
  const devBuyIn = devBuy ? ethers.utils.parseUnits(devBuy, 6) : ethers.constants.Zero;
  let target = AIRLOCK, calldata = p2.data, devBuyNote = '';
  if (!devBuyIn.isZero()) {
    target = BUNDLER;
    calldata = BUNDLER_IFACE.encodeFunctionData('bundle', [params, { permissionlessClaim: false, vestingDuration: 0, cliffDuration: 0 }, devBuyIn, deployer.address]);
    const usdg = new ethers.Contract(config.USDG, ERC20_IFACE, deployer);
    const allowance = await usdg.allowance(deployer.address, BUNDLER);
    if (allowance.lt(devBuyIn)) {
      if (!broadcast) devBuyNote = `USDG allowance to Bundler is ${ethers.utils.formatUnits(allowance, 6)}: the bundle cannot be simulated until approved (sent only with --broadcast)`;
      else { const atx = await usdg.approve(BUNDLER, devBuyIn, { gasPrice: await gasPrice(), type: 0 }); await atx.wait(); console.log(` approve    : USDG → Bundler ${atx.hash}`); }
    }
  }
  let gas = null;
  if (!devBuyNote) {
    try { gas = await provider.estimateGas({ from: deployer.address, to: target, data: calldata }); }
    catch (e) { throw new Error(`simulation reverted on ${target === BUNDLER ? 'Bundler.bundle' : 'Airlock.create'}: ${e.message.slice(0, 200)}`); }
  }
  const bal = await provider.getBalance(deployer.address);
  const gp = await gasPrice();

  const mcapUsd = Math.pow(1.0001, tick) * 1e12 * 1e9;
  console.log(`launch via Airlock ${AIRLOCK}`);
  console.log(` coin       : ${name} (${symbol}) supply ${config.DEFAULT_SUPPLY}${tokenURI ? ' · metadata ' + tokenURI : ' · no metadata (use --token-uri)'}`);
  console.log(` token      : ${p2.asset} (${ethers.BigNumber.from(p2.asset).lt(config.USDG) ? 'token0' : 'token1, curve flipped on-chain'})`);
  console.log(` sub-wallet : ${sub.address} (receives all fees in USDG; Doppler keeps 5% of each fee)`);
  console.log(` fee        : ${lpFeePips / 10_000}% hook fee, all in USDG${process.argv.includes('--snipe') ? ` · opens at ${SNIPE_START / 10_000}% → ${lpFeePips / 10_000}% in ${SNIPE_SECS}s` : ' · flat'} (Rehype ${REHYPE})`);
  console.log(` open       : tick ${tick} ≈ $${mcapUsd.toFixed(2)} mcap, one-sided to ${maxTick}`);
  if (!devBuyIn.isZero()) console.log(` dev buy    : ${ethers.utils.formatUnits(devBuyIn, 6)} USDG via Bundler ${BUNDLER} (fee waived except Doppler's 5% slice)${devBuyNote ? '\n              ⚠ ' + devBuyNote : ''}`);
  console.log(` gas        : ${gas ? gas.toString() : 'n/a'} @ ${ethers.utils.formatUnits(gp, 'gwei')} gwei · deployer ${deployer.address} balance ${ethers.utils.formatEther(bal)} ETH`);
  if (!broadcast) { console.log('\n--dry: nothing sent (add --broadcast)'); return; }

  if (!gas) gas = await provider.estimateGas({ from: deployer.address, to: target, data: calldata });
  const tx = await deployer.sendTransaction({ to: target, data: calldata, gasLimit: gas.mul(12).div(10), gasPrice: gp, type: 0 });
  console.log(` tx         : ${tx.hash}`);
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error('launch tx reverted');
  const rec = { token: p2.asset, symbol, name, subWallet: sub.address, numeraire: config.USDG, lpFeePips, tick, salt, devBuyUsdg: devBuy || null, rehype: REHYPE, tx: tx.hash, block: rc.blockNumber, at: new Date().toISOString(), venue: 'airlock-v4' };
  const p = path.resolve(__dirname, '..', 'state', 'airlock-launches.json');
  const list = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  list.push(rec);
  fs.writeFileSync(p + '.tmp', JSON.stringify(list, null, 1)); fs.renameSync(p + '.tmp', p);
  console.log(`\n✓ launched: ${p2.asset} — recorded in state/airlock-launches.json (NOT in the keeper registry)`);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
