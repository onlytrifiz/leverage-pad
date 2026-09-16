const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const v4 = require('../lib/v4');
const config = require('../config');

// live pools, launched on 2026-09-14 and recorded in state/airlock-launches.json
const TEST6 = '0x14D1422b1fBd10f4DFFE6Ab7127c53c0EdEAD445';
const TEST6_POOL = '0x7067ab2dd61c7e86ec016b0bb53a7b40326824b8a2c46e173aae9cb0bf55636c';
const TEST7 = '0x3335F28a0Dc28808849ed1025695f1f6ee2ef5D2';
const TEST7_POOL = '0x3c1fb4f38b8415e1be5d19b5b5efd5d765b195660ee70d7de901924f0ce0b252';

test('poolIdFor: matches the pool ids of live launches, whichever side the coin sorts on', async (t) => {
  await t.test('TEST6 (coin is token0)', () => {
    const k = v4.poolKeyFor(TEST6, config.USDG);
    assert.equal(k.currency0.toLowerCase(), TEST6.toLowerCase());
    assert.equal(k.fee, 0x800000);
    assert.equal(k.hooks, config.V4_HOOK_INITIALIZER);
    assert.equal(v4.poolIdFor(TEST6, config.USDG), TEST6_POOL);
  });
  await t.test('TEST7 (also token0: 0x3335… sorts before USDG 0x5fc5…)', () => {
    const k = v4.poolKeyFor(TEST7, config.USDG);
    assert.equal(k.currency0.toLowerCase(), TEST7.toLowerCase());
    assert.equal(v4.poolIdFor(TEST7, config.USDG), TEST7_POOL);
  });
  await t.test('a coin that sorts after USDG becomes currency1 and the key flips', () => {
    const high = '0xFFFF000000000000000000000000000000000001';
    const k = v4.poolKeyFor(high, config.USDG);
    assert.equal(k.currency0.toLowerCase(), config.USDG.toLowerCase());
    assert.equal(k.currency1.toLowerCase(), high.toLowerCase());
    assert.notEqual(v4.poolIdFor(high, config.USDG), v4.poolIdFor(TEST7, config.USDG));
  });
});

test('currentHookFee: flat, decaying, and settled', async (t) => {
  const flat = { startingTime: 1000, startFee: 30_000, endFee: 30_000, durationSeconds: 0 };
  const snipe = { startingTime: 1000, startFee: 800_000, endFee: 30_000, durationSeconds: 10 };
  await t.test('flat schedule is the end fee at any time', () => {
    assert.equal(v4.currentHookFee(flat, 0), 30_000);
    assert.equal(v4.currentHookFee(flat, 999_999), 30_000);
  });
  await t.test('protection: 80% at open, linear to the fee, then the fee forever', () => {
    assert.equal(v4.currentHookFee(snipe, 1000), 800_000);
    assert.equal(v4.currentHookFee(snipe, 1005), 800_000 - Math.floor(((800_000 - 30_000) * 5) / 10));
    assert.equal(v4.currentHookFee(snipe, 1010), 30_000);
    assert.equal(v4.currentHookFee(snipe, 5000), 30_000);
  });
  await t.test('a clock behind the start time never charges more than the start fee', () => {
    assert.equal(v4.currentHookFee(snipe, 900), 800_000);
  });
  await t.test('BigNumber fields (as ethers returns them) are accepted', () => {
    const bn = { startingTime: ethers.BigNumber.from(1000), startFee: ethers.BigNumber.from(800_000), endFee: ethers.BigNumber.from(30_000), durationSeconds: ethers.BigNumber.from(10) };
    assert.equal(v4.currentHookFee(bn, 1005), v4.currentHookFee(snipe, 1005));
  });
});

test('netOfHookFee: the hook takes its fee on the output', () => {
  assert.equal(v4.netOfHookFee(ethers.BigNumber.from(1_000_000), 30_000).toString(), '970000');
  assert.equal(v4.netOfHookFee(ethers.BigNumber.from(1_000_000), 800_000).toString(), '200000');
  assert.equal(v4.netOfHookFee(ethers.BigNumber.from(1_000_000), 0).toString(), '1000000');
});

test('buildV4SwapCalldata: decodes back to the swap that was asked for', async (t) => {
  const key = v4.poolKeyFor(TEST7, config.USDG);
  const amountIn = ethers.utils.parseUnits('25', 6);
  const minOut = ethers.utils.parseEther('1000');
  const data = v4.buildV4SwapCalldata({ poolKey: key, tokenIn: config.USDG, tokenOut: TEST7, amountIn, amountOutMinimum: minOut, deadlineSec: 600, nowSec: 1_800_000_000 });
  const [commands, inputs, deadline] = v4.UR_IFACE.decodeFunctionData('execute', data);
  const coder = ethers.utils.defaultAbiCoder;
  await t.test('one V4_SWAP command with the deadline asked', () => {
    assert.equal(commands, '0x10');
    assert.equal(inputs.length, 1);
    assert.equal(deadline.toNumber(), 1_800_000_600);
  });
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  await t.test('actions: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL', () => {
    assert.equal(actions, '0x060c0f');
    assert.equal(params.length, 3);
  });
  await t.test('swap params: our pool, buying the coin with USDG (the coin is currency0 here, so USDG in = oneForZero)', () => {
    const [p] = coder.decode(['tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)'], params[0]);
    assert.equal(p.poolKey[0].toLowerCase(), TEST7.toLowerCase());
    assert.equal(p.poolKey[1].toLowerCase(), config.USDG.toLowerCase());
    assert.equal(p.zeroForOne, false);
    assert.equal(p.amountIn.toString(), amountIn.toString());
    assert.equal(p.amountOutMinimum.toString(), minOut.toString());
  });
  await t.test('settle exactly the input, take at least the min out', () => {
    const [tIn, aIn] = coder.decode(['address', 'uint256'], params[1]);
    const [tOut, aOut] = coder.decode(['address', 'uint256'], params[2]);
    assert.equal(tIn.toLowerCase(), config.USDG.toLowerCase());
    assert.equal(aIn.toString(), amountIn.toString());
    assert.equal(tOut.toLowerCase(), TEST7.toLowerCase());
    assert.equal(aOut.toString(), minOut.toString());
  });
  await t.test('selling: the coin (currency0) as input is zeroForOne', () => {
    const sell = v4.buildV4SwapCalldata({ poolKey: key, tokenIn: TEST7, tokenOut: config.USDG, amountIn: minOut, amountOutMinimum: 1, nowSec: 0 });
    const [, ins] = v4.UR_IFACE.decodeFunctionData('execute', sell);
    const [, ps] = coder.decode(['bytes', 'bytes[]'], ins[0]);
    const [p] = coder.decode(['tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)'], ps[0]);
    assert.equal(p.zeroForOne, true);
  });
});

test('encodePermit2Approve: bounded allowance to the Universal Router', () => {
  const data = v4.encodePermit2Approve(config.USDG, 123, 456);
  const d = v4.PERMIT2_IFACE.decodeFunctionData('approve', data);
  assert.equal(d.token.toLowerCase(), config.USDG.toLowerCase());
  assert.equal(d.spender, config.UNIVERSAL_ROUTER);
  assert.equal(d.amount.toNumber(), 123);
  assert.equal(Number(d.expiration), 456); // uint48 decodes as a plain number in ethers v5
});
