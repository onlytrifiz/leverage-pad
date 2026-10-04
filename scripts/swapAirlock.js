const { ethers } = require('ethers');
const config = require('../config');
const { provider, gasPrice } = require('../lib/chain');
const { getSqrtRatioAtTick } = require('../lib/v3');
const fs = require('fs');
const path = require('path');

/**
 * swapAirlock.js — exact-in buy of an Airlock-launched coin on its Uniswap v4 pool via the
 * Universal Router (V4_SWAP). Requires the Permit2 approvals (USDG → Permit2, Permit2 → router).
 * The quote comes from Doppler's Quoter (QuoterMath over live pool state, crossing ticks); minOut is
 * the quote less the slippage cap, never zero. The closed-form estimate is kept only as a sanity print.
 *
 * Usage: buy : node scripts/swapAirlock.js --token 0x… [--usdg 5] [--slippage-bps 300] [--broadcast]
 *        sell: node scripts/swapAirlock.js --token 0x… --sell [--amount <tokens>] [--broadcast]
 * A sell below the launch tick finds no liquidity: the fill stops at the ladder floor and the unsold
 * tokens stay in the wallet (exact-in leaves the unconsumed input untouched).
 */
const UR = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const QUOTER = '0xce6cd4e35447e05a39a50a4bcf61f2dcd93a8f0d'; // Doppler Quoter (docs.doppler.lol contract addresses)
const MIN_SQRT = ethers.BigNumber.from('4295128740'), MAX_SQRT = ethers.BigNumber.from('1461446703485210103287273052203988822378723970341');
const INITIALIZER = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const DYNAMIC_FEE_FLAG = 0x800000;
const TICK_SPACING = 200;
const Q96 = ethers.BigNumber.from(2).pow(96);
const coder = ethers.utils.defaultAbiCoder;

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }

async function main() {
  const token = ethers.utils.getAddress(arg('token', ''));
  const sell = process.argv.includes('--sell');
  const usdgIn = ethers.utils.parseUnits(arg('usdg', '5'), 6);
  const slippageBps = Number(arg('slippage-bps', 300));
  const broadcast = process.argv.includes('--broadcast');
  const w = new ethers.Wallet(config.DEPLOYER_KEY, provider);

  const tokenIs0 = ethers.BigNumber.from(token).lt(config.USDG);
  const poolKey = { currency0: tokenIs0 ? token : config.USDG, currency1: tokenIs0 ? config.USDG : token, fee: DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING, hooks: INITIALIZER };
  const poolId = ethers.utils.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]));
  const pm = new ethers.Contract(PM, ['function extsload(bytes32) view returns (bytes32)'], provider);
  const base = ethers.utils.keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6]));
  const s0 = ethers.BigNumber.from(await pm.extsload(base));
  const sqrtP = s0.and(ethers.BigNumber.from(1).shl(160).sub(1));
  const lpFee = s0.shr(208).and(0xffffff).toNumber();
  // Active liquidity can be zero at the launch price and the pool still trades: when the coin
  // sorts after USDG the curve is flipped and the price sits exactly on the range's upper bound,
  // which the range [lower, upper) excludes. A buy crosses into it. The Quoter below is the truth;
  // the closed form is only a sanity print, and is skipped when there is no L to compute it from.
  const L = ethers.BigNumber.from(await pm.extsload(ethers.BigNumber.from(base).add(3).toHexString())); // slot0 + 3 = liquidity

  const w20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], w);
  let amountIn = usdgIn, tokenIn = config.USDG, tokenOut = token;
  if (sell) {
    tokenIn = token; tokenOut = config.USDG;
    amountIn = arg('amount', '') ? ethers.utils.parseEther(arg('amount', '')) : await w20.balanceOf(w.address);
    if (amountIn.isZero()) throw new Error('nothing to sell');
  }
  // direction: zeroForOne when the input is currency0
  const zeroForOne = sell ? tokenIs0 : !tokenIs0;
  const amountInNet = amountIn.mul(1_000_000 - lpFee).div(1_000_000);
  // the one-sided ladder has no liquidity below its launch tick: clamp the projected price there
  const recs = fs.existsSync(path.resolve(__dirname, '..', 'state', 'airlock-launches.json')) ? JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'state', 'airlock-launches.json'), 'utf8')) : [];
  const rec = recs.find((r) => r.token.toLowerCase() === token.toLowerCase());
  const floorTick = rec ? (tokenIs0 ? rec.tick : -rec.tick) : null; // price is token1/token0; the flipped curve mirrors the tick
  let out = null;
  if (!L.isZero()) {
    if (zeroForOne) { // input = currency0: price falls; 1/sqrtP' = 1/sqrtP + in/L
      let sqrtPNew = L.mul(sqrtP).div(L.add(amountInNet.mul(sqrtP).div(Q96)));
      if (floorTick !== null && tokenIs0) { const f = getSqrtRatioAtTick(floorTick); if (sqrtPNew.lt(f)) sqrtPNew = f; }
      out = L.mul(sqrtP.sub(sqrtPNew)).div(Q96);
    } else {          // input = currency1: sqrtP' = sqrtP + in*Q96/L; out0 = L*(sqrtP'-sqrtP)*Q96/(sqrtP*sqrtP')
      let sqrtPNew = sqrtP.add(amountInNet.mul(Q96).div(L));
      if (floorTick !== null && !tokenIs0) { const f = getSqrtRatioAtTick(floorTick); if (sqrtPNew.gt(f)) sqrtPNew = f; }
      out = L.mul(sqrtPNew.sub(sqrtP)).mul(Q96).div(sqrtP).div(sqrtPNew);
    }
  }
  const fmtOutRaw = (v) => sell ? ethers.utils.formatUnits(v, 6) + ' USDG' : ethers.utils.formatEther(v) + ' tokens';
  // Doppler Quoter: exact-in (negative amountSpecified), no price limit
  const quoter = new ethers.Contract(QUOTER, ['function quoteSingle((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params) view returns (int256 amount0,int256 amount1,uint160 sqrtPriceAfter,uint32 initializedTicksCrossed)'], provider);
  const q = await quoter.quoteSingle(
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    { zeroForOne, amountSpecified: amountIn.mul(-1), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT.add(1) : MAX_SQRT.sub(1) },
  );
  // The Quoter is hookless: it does not see the Rehype fee, which is taken from the OUTPUT after the
  // swap (currentFee from the schedule, linear decay, 1e6-based). Apply it before the slippage haircut.
  const REHYPE = '0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215';
  const rehype = new ethers.Contract(REHYPE, ['function getFeeSchedule(bytes32) view returns (uint32 startingTime,uint24 startFee,uint24 endFee,uint24 lastFee,uint32 durationSeconds)'], provider);
  const sch = await rehype.getFeeSchedule(poolId);
  const now = Math.floor(Date.now() / 1000);
  let hookFee = sch.endFee;
  if (sch.startFee !== sch.endFee && sch.durationSeconds !== 0) {
    const elapsed = Math.max(0, now - sch.startingTime);
    hookFee = elapsed >= sch.durationSeconds ? sch.endFee : sch.startFee - Math.floor((sch.startFee - sch.endFee) * elapsed / sch.durationSeconds);
  }
  const quotedGross = (zeroForOne ? q.amount1 : q.amount0).abs();
  const quoted = quotedGross.mul(1_000_000 - hookFee).div(1_000_000);
  console.log(` hook fee now ${hookFee / 1e4}%${sch.startFee !== sch.endFee ? ' (decaying schedule)' : ''} · gross ${fmtOutRaw(quotedGross)}`);
  console.log(` closed-form estimate ${out ? fmtOutRaw(out) : 'n/a (no active liquidity at the current tick)'} · quoter net of hook fee ${fmtOutRaw(quoted)} (ticks crossed ${q.initializedTicksCrossed})`);
  if (quoted.isZero()) throw new Error('quoted output is zero: nothing on the other side of the ladder');
  out = quoted;
  const minOut = out.mul(10_000 - slippageBps).div(10_000);
  const fmtOut = fmtOutRaw;
  console.log(`pool ${poolId}\n lpFee ${lpFee / 1e4}% · L ${L.toString()} · ${sell ? 'selling ' + ethers.utils.formatEther(amountIn) + ' tokens' : 'buying with ' + ethers.utils.formatUnits(amountIn, 6) + ' USDG'} · expected out ≈ ${fmtOut(out)} · minOut ${fmtOut(minOut)}`);
  if (sell && broadcast) { // Permit2 path for the token side
    const p2 = new ethers.Contract(PERMIT2, ['function allowance(address,address,address) view returns (uint160,uint48,uint48)', 'function approve(address,address,uint160,uint48)'], w);
    if ((await w20.allowance(w.address, PERMIT2)).lt(amountIn)) { const t = await w20.approve(PERMIT2, ethers.constants.MaxUint256, { gasPrice: await gasPrice(), type: 0 }); await t.wait(); console.log(' approve token→Permit2', t.hash); }
    const [a] = await p2.allowance(w.address, token, UR);
    if (ethers.BigNumber.from(a).lt(amountIn)) { const t = await p2.approve(token, UR, amountIn, Math.floor(Date.now() / 1000) + 3600, { gasPrice: await gasPrice(), type: 0 }); await t.wait(); console.log(' Permit2.approve token→UR', t.hash); }
  }

  const actions = ethers.utils.solidityPack(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const params = [
    coder.encode(['tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)'],
      [{ poolKey: [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0, hookData: '0x' }]),
    coder.encode(['address', 'uint256'], [tokenIn, amountIn]),
    coder.encode(['address', 'uint256'], [tokenOut, minOut]),
  ];
  const inputs = [coder.encode(['bytes', 'bytes[]'], [actions, params])];
  const ur = new ethers.Contract(UR, ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'], w);
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const gas = await ur.estimateGas.execute('0x10', inputs, deadline); // simulation: reverts here if anything is off
  console.log(` gas ${gas.toString()} · from ${w.address}`);
  if (!broadcast) { console.log('--dry: nothing sent'); return; }
  const tx = await ur.execute('0x10', inputs, deadline, { gasLimit: gas.mul(12).div(10), gasPrice: await gasPrice(), type: 0 });
  console.log(' tx', tx.hash);
  const rc = await tx.wait();
  console.log(rc.status === 1 ? '✓ swap confirmed' : '✗ reverted');
}
main().catch((e) => { console.error('Error:', e.message.slice(0, 400)); process.exit(1); });
