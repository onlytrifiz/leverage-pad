const { ethers } = require('ethers');

/**
 * v3.js — matematica e piani di lancio Uniswap V3 (estratto da launchDirect.js)
 *
 * getSqrtRatioAtTick e' il port esatto di TickMath verificato bit-per-bit contro
 * l'Initialize del pool SPENDRA (lancio pons reale). buildLaunchPlan costruisce
 * la multicall createAndInitializePoolIfNecessary + mint one-sided: prezzo
 * iniziale sul bordo del range, tutta la supply da una parte sola.
 */

const BN = ethers.BigNumber.from;

function getSqrtRatioAtTick(tick) {
  const absTick = Math.abs(tick);
  if (absTick > 887272) throw new Error('tick fuori range: ' + tick);
  let ratio = (absTick & 0x1) ? BN('0xfffcb933bd6fad37aa2d162d1a594001') : BN('0x100000000000000000000000000000000');
  const muls = [
    [0x2, '0xfff97272373d413259a46990580e213a'], [0x4, '0xfff2e50f5f656932ef12357cf3c7fdcc'],
    [0x8, '0xffe5caca7e10e4e61c3624eaa0941cd0'], [0x10, '0xffcb9843d60f6159c9db58835c926644'],
    [0x20, '0xff973b41fa98c081472e6896dfb254c0'], [0x40, '0xff2ea16466c96a3843ec78b326b52861'],
    [0x80, '0xfe5dee046a99a2a811c461f1969c3053'], [0x100, '0xfcbe86c7900a88aedcffc83b479aa3a4'],
    [0x200, '0xf987a7253ac413176f2b074cf7815e54'], [0x400, '0xf3392b0822b70005940c7a398e4b70f3'],
    [0x800, '0xe7159475a2c29b7443b29c7fa6e889d9'], [0x1000, '0xd097f3bdfd2022b8845ad8f792aa5825'],
    [0x2000, '0xa9f746462d870fdf8a65dc1f90e061e5'], [0x4000, '0x70d869a156d2a1b890bb3df62baf32f7'],
    [0x8000, '0x31be135f97d08fd981231505542fcfa6'], [0x10000, '0x9aa508b5b7a84e1c677de54f3e99bc9'],
    [0x20000, '0x5d6af8dedb81196699c329225ee604'], [0x40000, '0x2216e584f5fa1ea926041bedfe98'],
    [0x80000, '0x48a170391f7dc42444e8fa2'],
  ];
  for (const [mask, mul] of muls) if (absTick & mask) ratio = ratio.mul(BN(mul)).shr(128);
  if (tick > 0) ratio = ethers.constants.MaxUint256.div(ratio);
  const rem = ratio.mod(BN(2).pow(32));
  return ratio.shr(32).add(rem.isZero() ? 0 : 1); // Q128.128 → Q64.96, round up
}

const npmIface = new ethers.utils.Interface([
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const routerIface = new ethers.utils.Interface([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
]);

// one-sided: tutta la supply del token nuovo, prezzo iniziale sul bordo del range
function buildLaunchPlan({ token, pair, fee, spacing, supplyRaw, mcapRaw, recipient }) {
  const newIsToken1 = BN(token).gt(BN(pair));
  const token0 = newIsToken1 ? pair : token;
  const token1 = newIsToken1 ? token : pair;
  const ratio = newIsToken1
    ? Number(supplyRaw.toString()) / Number(mcapRaw.toString())
    : Number(mcapRaw.toString()) / Number(supplyRaw.toString());
  const rawTick = Math.log(ratio) / Math.log(1.0001);
  let tick = Math.round(rawTick / spacing) * spacing;
  const minTick = Math.ceil(-887272 / spacing) * spacing;
  const maxTick = Math.floor(887272 / spacing) * spacing;
  if (tick <= minTick || tick >= maxTick) throw new Error(`tick ${tick} fuori range [${minTick}, ${maxTick}]: mcap/supply assurdi`);
  const sqrtPriceX96 = getSqrtRatioAtTick(tick);
  const tickLower = newIsToken1 ? minTick : tick;
  const tickUpper = newIsToken1 ? tick : maxTick;
  const amount0Desired = newIsToken1 ? ethers.constants.Zero : supplyRaw;
  const amount1Desired = newIsToken1 ? supplyRaw : ethers.constants.Zero;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const calls = [
    npmIface.encodeFunctionData('createAndInitializePoolIfNecessary', [token0, token1, fee, sqrtPriceX96]),
    npmIface.encodeFunctionData('mint', [{
      token0, token1, fee, tickLower, tickUpper,
      amount0Desired, amount1Desired,
      amount0Min: 0, amount1Min: 0, // sicuro: il pool nasce nella stessa tx
      recipient, deadline,
    }]),
  ];
  const data = npmIface.encodeFunctionData('multicall', [calls]);
  const priceEff = Math.pow(1.0001, tick);
  const tokenPerPair = newIsToken1 ? priceEff : 1 / priceEff;
  return { newIsToken1, token0, token1, tick, sqrtPriceX96, tickLower, tickUpper, data, tokenPerPair };
}

// calldata swap exact-in tokenIn→tokenOut via SwapRouter02 (serve l'approve).
// amountOutMinimum va SEMPRE passato reale dal chiamante (0 = nessuna protezione slippage).
function buildSwapCalldata({ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum = 0, deadlineSec = 600 }) {
  const inner = routerIface.encodeFunctionData('exactInputSingle', [{
    tokenIn, tokenOut, fee, recipient,
    amountIn, amountOutMinimum, sqrtPriceLimitX96: 0,
  }]);
  return routerIface.encodeFunctionData('multicall', [Math.floor(Date.now() / 1000) + deadlineSec, [inner]]);
}

const SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

module.exports = { BN, getSqrtRatioAtTick, buildLaunchPlan, buildSwapCalldata, npmIface, routerIface, SPACING_BY_FEE };
