const { ethers } = require('ethers');
const config = require('../config');
const { provider, gasPrice } = require('../lib/chain');
const { validateLaunchParams } = require('../lib/launchParams');
const { deriveSubWallet, checkFingerprint } = require('../lib/subwallet');
const { ROUTER_IFACE, SIDES, RISKS } = require('../lib/routerCoins');

/**
 * launchRouter.js — launch a coin through the MultiplyLaunchRouter from the CLI.
 *
 * Same transaction the site signs on /launch, from the deployer key: the router builds the
 * Doppler CreateParams, clones the coin's fee sink and emits MultiplyLaunch, which is how the
 * keeper learns about the coin. Nothing is written to the registry here: the keeper's sync does
 * that on its next tick, from the chain.
 *
 * The engine (market, side, leverage, risk) goes on-chain in the launch input and comes back
 * in the MultiplyEngine event: that is what the keeper reads. The tokenURI is only for
 * terminals (logo, description): `--token-uri ipfs://…` pinned through the site's
 * /api/metadata, or empty for a test coin.
 *
 * Usage: node scripts/launchRouter.js --name "Test 8" --symbol TEST8 --market NVDA --side long --lev 3
 *          [--risk balanced] [--fee-bps 300] [--snipe] [--mcap 4000] [--first-buy 5]
 *          [--token-uri ipfs://…] [--broadcast]
 * Without --broadcast: simulation only (eth_call on router.launch), nothing sent.
 */

const ROUTER_ABI = new ethers.utils.Interface([
  'function launch((string name,string symbol,string tokenURI,uint24 fee,bool antiSnipe,uint256 mcap,uint128 firstBuy,bytes32 salt,string market,uint8 side,uint8 leverage,uint8 risk) input) returns (address asset,bytes32 poolId,uint128 firstBuyOut)',
  'function predictSink(address launcher,bytes32 salt) view returns (address)',
  'function sinkConfig() view returns ((address implementation,address keeper,address treasury,uint16 treasuryBps))',
  'function paused() view returns (bool)',
]);
const ERC20_IFACE = new ethers.utils.Interface(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes('--' + n);

async function main() {
  const broadcast = flag('broadcast');
  if (!config.DEPLOYER_KEY) throw new Error('DEPLOYER_PRIVATE_KEY missing in .env');
  checkFingerprint();
  const launcher = new ethers.Wallet(config.DEPLOYER_KEY, provider);

  // the same validation the keeper applies when it reads the metadata back
  const p = validateLaunchParams({
    name: arg('name', ''), symbol: arg('symbol', ''), market: arg('market', ''), side: arg('side', ''),
    leverage: Number(arg('lev', '0')), riskProfile: arg('risk', config.DEFAULT_RISK), creator: arg('creator', launcher.address),
  });
  const feePips = Number(arg('fee-bps', '300')) * 100;
  const antiSnipe = flag('snipe');
  const mcapRaw = arg('mcap', '') ? ethers.utils.parseUnits(arg('mcap', ''), 6) : ethers.constants.Zero;
  const firstBuy = arg('first-buy', '') ? ethers.utils.parseUnits(arg('first-buy', ''), 6) : ethers.constants.Zero;
  const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));

  const tokenURI = arg('token-uri', '');
  const input = {
    name: p.name, symbol: p.symbol, tokenURI, fee: feePips, antiSnipe, mcap: mcapRaw, firstBuy, salt,
    market: p.market, side: SIDES.indexOf(p.side), leverage: p.leverage, risk: RISKS.indexOf(p.riskProfile),
  };

  const router = new ethers.Contract(config.LAUNCH_ROUTER, ROUTER_ABI, provider);
  if (await router.paused()) throw new Error('router is paused');
  let sink = null, sinkCfg = null;
  try { sinkCfg = await router.sinkConfig(); sink = await router.predictSink(launcher.address, salt); } catch { /* pre-upgrade router: no sinks */ }
  if (sink && ethers.BigNumber.from(sink).isZero()) sink = null;

  if (!firstBuy.isZero() && broadcast) {
    const usdg = new ethers.Contract(config.USDG, ERC20_IFACE, launcher);
    if ((await usdg.allowance(launcher.address, config.LAUNCH_ROUTER)).lt(firstBuy)) {
      const tx = await usdg.approve(config.LAUNCH_ROUTER, firstBuy, { gasPrice: await gasPrice(), type: 0 });
      await tx.wait();
      console.log(` approve    : USDG → router ${tx.hash}`);
    }
  }

  const data = ROUTER_ABI.encodeFunctionData('launch', [input]);
  let asset, poolId, simNote = '';
  try {
    const ret = await provider.call({ from: launcher.address, to: config.LAUNCH_ROUTER, data });
    [asset, poolId] = ROUTER_ABI.decodeFunctionResult('launch', ret);
  } catch (e) {
    if (!firstBuy.isZero() && !broadcast) simNote = 'first buy needs the USDG approval first (sent only with --broadcast): simulation skipped';
    else if (/data="0x"/.test(e.message) && !sinkCfg) throw new Error('router.launch reverts with no data and the router has no sinkConfig(): the live router predates the on-chain engine and sinks. Broadcast script/UpgradeRouterSink.s.sol first.');
    else throw new Error('router.launch reverts in simulation: ' + e.message.slice(0, 200));
  }
  const gas = simNote ? null : await provider.estimateGas({ from: launcher.address, to: config.LAUNCH_ROUTER, data });

  console.log(`launch via MultiplyLaunchRouter ${config.LAUNCH_ROUTER}`);
  console.log(` coin       : ${p.name} (${p.symbol}) · ${p.market} ${p.side} ${p.leverage}x · ${p.riskProfile}`);
  console.log(` fee        : ${feePips / 10_000}% hook fee in USDG${antiSnipe ? ' · protection on (80% → fee in 10 s)' : ' · flat'}`);
  console.log(` mcap       : ${mcapRaw.isZero() ? 'policy default' : '$' + ethers.utils.formatUnits(mcapRaw, 6)}`);
  console.log(` token      : ${asset || '(not simulated)'}${poolId ? '  pool ' + poolId : ''}`);
  console.log(` sub-wallet : ${asset ? deriveSubWallet(asset).address : '(needs the token address)'}`);
  console.log(` sink       : ${sink ? `${sink} (${Number(sinkCfg.treasuryBps) / 100}% treasury, keeper ${sinkCfg.keeper})` : 'NONE: the router has no sink config, fees would go to the hub'}`);
  console.log(` engine     : on-chain (MultiplyEngine event) · metadata ${tokenURI || 'none (no logo for terminals)'}`);
  if (!firstBuy.isZero()) console.log(` first buy  : ${ethers.utils.formatUnits(firstBuy, 6)} USDG${simNote ? '\n              ⚠ ' + simNote : ''}`);
  console.log(` gas        : ${gas ? gas.toString() : 'n/a'} · launcher ${launcher.address}`);
  if (!broadcast) { console.log('\n--dry: nothing sent (add --broadcast)'); return; }
  if (!sink && !flag('allow-no-sink')) throw new Error('refusing to launch without a sink (fees would land on the hub EOA); pass --allow-no-sink to override');

  const tx = await launcher.sendTransaction({ to: config.LAUNCH_ROUTER, data, gasLimit: (gas || ethers.BigNumber.from(2_500_000)).mul(12).div(10), gasPrice: await gasPrice(), type: 0 });
  console.log(` tx         : ${tx.hash}`);
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error('launch reverted');
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== config.LAUNCH_ROUTER.toLowerCase()) continue;
    try {
      const ev = ROUTER_IFACE.parseLog(l);
      if (ev.name === 'MultiplyLaunch') console.log(`\n✓ launched ${ev.args.asset} (pool ${ev.args.poolId}) at block ${l.blockNumber}`);
      if (ev.name === 'FeeSink') console.log(`  fee sink ${ev.args.sink}`);
      if (ev.name === 'MultiplyEngine') console.log(`  engine ${ev.args.market} side ${ev.args.side} ${ev.args.leverage}x risk ${ev.args.risk}`);
    } catch { /* other event */ }
  }
  console.log('  the keeper adopts the coin on its next tick (sync from MultiplyLaunch → setDestination on the sink)');
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
