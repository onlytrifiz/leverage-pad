const { ethers } = require('ethers');
const config = require('../config');

/**
 * v4.js — Uniswap v4 on Robinhood Chain, for coins launched through the router.
 *
 * A router coin has no pool contract: its market is a pool id inside the PoolManager,
 * with Doppler's hook initializer as the hook and a dynamic fee flag. Swaps go through
 * Doppler's Universal Router (encoding 2.1.1) with Permit2 in front, quotes come from
 * Doppler's Quoter, which is hookless: the Rehype takes its fee on the OUTPUT of the swap,
 * so the quote must be discounted by the fee the hook is charging right now (flat, or
 * decaying during the launch protection window).
 *
 * The same math as web/components/SwapPanel.tsx and scripts/swapAirlock.js: if a price is
 * right there, it is right here. Pure functions first (covered by the dry tests), RPC
 * helpers after.
 */

const BN = ethers.BigNumber.from;
const coder = ethers.utils.defaultAbiCoder;

const DYNAMIC_FEE_FLAG = 0x800000;
const MIN_SQRT = BN('4295128740');
const MAX_SQRT = BN('1461446703485210103287273052203988822378723970341');
const PIPS = 1_000_000;

const QUOTER_IFACE = new ethers.utils.Interface([
  'function quoteSingle((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params) view returns (int256 amount0,int256 amount1,uint160 sqrtPriceAfter,uint32 initializedTicksCrossed)',
]);
const REHYPE_IFACE = new ethers.utils.Interface([
  'function getFeeSchedule(bytes32) view returns (uint32 startingTime,uint24 startFee,uint24 endFee,uint24 lastFee,uint32 durationSeconds)',
  'function getHookFees(bytes32) view returns (uint128 fees0,uint128 fees1,uint128 beneficiaryFees0,uint128 beneficiaryFees1,uint128 airlockOwnerFees0,uint128 airlockOwnerFees1,uint24 customFee)',
  'function getPoolInfo(bytes32) view returns (address asset,address numeraire,address buybackDst)',
  'function collectFees(address asset) returns (int256 fees)',
]);
const PERMIT2_IFACE = new ethers.utils.Interface([
  'function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
]);
const UR_IFACE = new ethers.utils.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const PM_IFACE = new ethers.utils.Interface(['function extsload(bytes32 slot) view returns (bytes32)']);

// ── pure ────────────────────────────────────────────────────────────────────

/** the PoolKey of a router coin against its numeraire */
function poolKeyFor(asset, numeraire, { tickSpacing = config.V4_TICK_SPACING, hooks = config.V4_HOOK_INITIALIZER } = {}) {
  const assetIs0 = BN(asset).lt(BN(numeraire));
  return {
    currency0: assetIs0 ? asset : numeraire,
    currency1: assetIs0 ? numeraire : asset,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing,
    hooks,
  };
}

/** pool id = keccak of the PoolKey (also DexScreener's pair id) */
function poolIdFor(asset, numeraire, opts) {
  const k = poolKeyFor(asset, numeraire, opts);
  return ethers.utils.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}

/**
 * The hook fee in force at `nowSec`, from the pool's Rehype schedule: flat when start and
 * end coincide (or no duration), linear decay from startFee to endFee otherwise.
 */
function currentHookFee(schedule, nowSec) {
  const start = Number(schedule.startFee), end = Number(schedule.endFee), dur = Number(schedule.durationSeconds);
  if (start === end || dur <= 0) return end;
  const elapsed = Math.max(0, Math.floor(nowSec) - Number(schedule.startingTime));
  if (elapsed >= dur) return end;
  return start - Math.floor(((start - end) * elapsed) / dur);
}

/** what the trader receives: the Quoter's gross output less the hook fee (taken on the output) */
function netOfHookFee(grossOut, hookFeePips) {
  return BN(grossOut).mul(PIPS - hookFeePips).div(PIPS);
}

/** Universal Router calldata for one exact-in v4 swap: V4_SWAP → SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL */
function buildV4SwapCalldata({ poolKey, tokenIn, tokenOut, amountIn, amountOutMinimum, deadlineSec = 600, nowSec = Math.floor(Date.now() / 1000) }) {
  const zeroForOne = tokenIn.toLowerCase() === poolKey.currency0.toLowerCase();
  const actions = ethers.utils.solidityPack(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]);
  const params = [
    coder.encode(
      ['tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)'],
      [{ poolKey: [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0, hookData: '0x' }],
    ),
    coder.encode(['address', 'uint256'], [tokenIn, amountIn]),
    coder.encode(['address', 'uint256'], [tokenOut, amountOutMinimum]),
  ];
  const inputs = [coder.encode(['bytes', 'bytes[]'], [actions, params])];
  return UR_IFACE.encodeFunctionData('execute', ['0x10', inputs, nowSec + deadlineSec]);
}

// ── RPC ─────────────────────────────────────────────────────────────────────

/**
 * Exact-in quote net of the current hook fee. `out` is what the recipient gets; minOut is
 * the caller's business (slippage on top).
 */
async function quoteExactInV4(provider, { asset, numeraire, tokenIn, amountIn, nowSec = Math.floor(Date.now() / 1000) }) {
  const poolKey = poolKeyFor(asset, numeraire);
  const poolId = poolIdFor(asset, numeraire);
  const zeroForOne = tokenIn.toLowerCase() === poolKey.currency0.toLowerCase();
  const quoter = new ethers.Contract(config.V4_QUOTER, QUOTER_IFACE, provider);
  const rehype = new ethers.Contract(config.REHYPE, REHYPE_IFACE, provider);
  const [q, s] = await Promise.all([
    quoter.quoteSingle(poolKey, { zeroForOne, amountSpecified: BN(amountIn).mul(-1), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT.add(1) : MAX_SQRT.sub(1) }),
    rehype.getFeeSchedule(poolId),
  ]);
  const gross = (zeroForOne ? q.amount1 : q.amount0).abs();
  const hookFee = currentHookFee(s, nowSec);
  return { poolKey, poolId, zeroForOne, gross, hookFee, out: netOfHookFee(gross, hookFee) };
}

/** liquidity at the current tick, from the PoolManager's storage (pools[] lives at slot 6) */
async function poolLiquidity(provider, poolId) {
  const base = ethers.utils.keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6]));
  const pm = new ethers.Contract(config.V4_POOL_MANAGER, PM_IFACE, provider);
  return BN(await pm.extsload(BN(base).add(3).toHexString()));
}

/** Permit2's bounded allowance for (owner, token → spender) */
async function permit2Allowance(provider, owner, token, spender = config.UNIVERSAL_ROUTER) {
  const p2 = new ethers.Contract(config.PERMIT2, PERMIT2_IFACE, provider);
  const [amount, expiration] = await p2.allowance(owner, token, spender);
  return { amount: BN(amount), expiration: Number(expiration) };
}

function encodePermit2Approve(token, amount, expirationSec, spender = config.UNIVERSAL_ROUTER) {
  return PERMIT2_IFACE.encodeFunctionData('approve', [token, spender, amount, expirationSec]);
}

async function hookFees(provider, poolId) {
  const rehype = new ethers.Contract(config.REHYPE, REHYPE_IFACE, provider);
  const f = await rehype.getHookFees(poolId);
  return {
    fees0: BN(f.fees0), fees1: BN(f.fees1),
    beneficiaryFees0: BN(f.beneficiaryFees0), beneficiaryFees1: BN(f.beneficiaryFees1),
    airlockOwnerFees0: BN(f.airlockOwnerFees0), airlockOwnerFees1: BN(f.airlockOwnerFees1),
  };
}

module.exports = {
  BN, DYNAMIC_FEE_FLAG, PIPS,
  QUOTER_IFACE, REHYPE_IFACE, PERMIT2_IFACE, UR_IFACE,
  poolKeyFor, poolIdFor, currentHookFee, netOfHookFee, buildV4SwapCalldata,
  quoteExactInV4, poolLiquidity, permit2Allowance, encodePermit2Approve, hookFees,
};
