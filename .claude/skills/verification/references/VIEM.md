# Viem Scripts

Node.js scripts using viem for complex calculations and precision math. Best for price conversions, expected value calculations, and multi-step verification.

## Setup

```bash
# Create project
mkdir doppler-verify && cd doppler-verify
npm init -y
npm install viem

# Create script
touch verify.mjs
```

Basic client setup:

```javascript
// verify.mjs
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL),
});

// Run with: node verify.mjs
```

---

## Price Conversion Utilities

### sqrtPriceX96 to Human Price

```javascript
/**
 * Convert sqrtPriceX96 to human-readable price
 * @param sqrtPriceX96 - The sqrt price in Q64.96 format
 * @param token0Decimals - Decimals of token0
 * @param token1Decimals - Decimals of token1
 * @returns Price of token0 in terms of token1
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, token0Decimals, token1Decimals) {
  const Q96 = 2n ** 96n;
  const sqrtPrice = BigInt(sqrtPriceX96);

  // price = (sqrtPriceX96 / 2^96)^2
  // For precision: (sqrtPriceX96^2) / (2^192)
  const numerator = sqrtPrice * sqrtPrice;
  const denominator = Q96 * Q96;

  // Adjust for token decimals
  // price represents token1/token0 (how much token1 per token0)
  const decimalDiff = token0Decimals - token1Decimals;

  // Scale for precision
  const PRECISION = 10n ** 18n;
  let priceScaled;

  if (decimalDiff >= 0) {
    priceScaled = (numerator * PRECISION * (10n ** BigInt(decimalDiff))) / denominator;
  } else {
    priceScaled = (numerator * PRECISION) / (denominator * (10n ** BigInt(-decimalDiff)));
  }

  return Number(priceScaled) / 1e18;
}

// Example: ETH/USDC pool (token0=USDC 6 dec, token1=ETH 18 dec)
// If sqrtPriceX96 represents 1 ETH = 2000 USDC:
// const price = sqrtPriceX96ToPrice(sqrtPriceX96, 6, 18);
// console.log(`1 USDC = ${price} ETH`);
// To get ETH price in USDC: 1/price
```

### Tick to Price

```javascript
/**
 * Convert tick to price
 * @param tick - The tick value
 * @param token0Decimals - Decimals of token0
 * @param token1Decimals - Decimals of token1
 * @returns Price of token0 in terms of token1
 */
function tickToPrice(tick, token0Decimals, token1Decimals) {
  // price = 1.0001^tick
  const price = Math.pow(1.0001, tick);

  // Adjust for decimals
  const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
  return price * decimalAdjustment;
}

/**
 * Convert price to tick (approximate)
 */
function priceToTick(price, token0Decimals, token1Decimals) {
  const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
  const rawPrice = price / decimalAdjustment;

  // tick = log(price) / log(1.0001)
  return Math.floor(Math.log(rawPrice) / Math.log(1.0001));
}
```

### Tick Alignment

```javascript
/**
 * Align tick to tick spacing
 * @param tick - The tick to align
 * @param tickSpacing - The tick spacing
 * @param roundDown - Round down (true) or up (false)
 */
function alignTick(tick, tickSpacing, roundDown = true) {
  if (roundDown) {
    return Math.floor(tick / tickSpacing) * tickSpacing;
  }
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

/**
 * Check if tick is aligned
 */
function isTickAligned(tick, tickSpacing) {
  return tick % tickSpacing === 0;
}
```

---

## Doppler State Readers

### V4 Dynamic Auction State

```javascript
const dopplerAbi = parseAbi([
  'function isToken0() view returns (bool)',
  'function startingTick() view returns (int24)',
  'function endingTick() view returns (int24)',
  'function gamma() view returns (int24)',
  'function startingTime() view returns (uint256)',
  'function endingTime() view returns (uint256)',
  'function epochLength() view returns (uint256)',
  'function numTokensToSell() view returns (uint256)',
  'function minimumProceeds() view returns (uint256)',
  'function maximumProceeds() view returns (uint256)',
  'function earlyExit() view returns (bool)',
  'function insufficientProceeds() view returns (bool)',
  'function state() view returns (uint40, int256, uint256, uint256, uint256, int128, int128)',
  'function getCurrentEpoch() view returns (uint256)',
  'function getNormalizedTimeElapsed(uint256) view returns (uint256)',
  'function getExpectedAmountSold() view returns (uint256)',
  'function getMaxTickDeltaPerEpoch() view returns (int256)',
  'function getNumPDSlugs() view returns (uint256)',
  'function positions(bytes32) view returns (int24, int24, uint128, uint8)',
]);

async function readDopplerState(client, hookAddress) {
  const [
    isToken0,
    startingTick,
    endingTick,
    gamma,
    startingTime,
    endingTime,
    epochLength,
    numTokensToSell,
    minimumProceeds,
    maximumProceeds,
    earlyExit,
    insufficientProceeds,
    stateResult,
    currentEpoch,
  ] = await Promise.all([
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'isToken0' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'startingTick' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'endingTick' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'gamma' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'startingTime' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'endingTime' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'epochLength' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'numTokensToSell' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'minimumProceeds' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'maximumProceeds' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'earlyExit' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'insufficientProceeds' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'state' }),
    client.readContract({ address: hookAddress, abi: dopplerAbi, functionName: 'getCurrentEpoch' }),
  ]);

  return {
    config: {
      isToken0,
      startingTick,
      endingTick,
      gamma,
      startingTime,
      endingTime,
      epochLength,
      numTokensToSell,
      minimumProceeds,
      maximumProceeds,
    },
    status: {
      earlyExit,
      insufficientProceeds,
      currentEpoch,
    },
    state: {
      lastEpoch: stateResult[0],
      tickAccumulator: stateResult[1],
      totalTokensSold: stateResult[2],
      totalProceeds: stateResult[3],
      totalTokensSoldLastEpoch: stateResult[4],
      fees0: stateResult[5],
      fees1: stateResult[6],
    },
  };
}
```

### V3 Pool State

```javascript
const poolAbi = parseAbi([
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);

async function readV3PoolState(client, poolAddress) {
  const [slot0, liquidity, token0, token1, fee] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'liquidity' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'fee' }),
  ]);

  return {
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    observationIndex: slot0[2],
    liquidity,
    token0,
    token1,
    fee,
  };
}
```

---

## Auction Progress Analyzer

```javascript
const WAD = 10n ** 18n;

async function analyzeAuctionProgress(client, hookAddress, assetDecimals, numeraireDecimals) {
  const doppler = await readDopplerState(client, hookAddress);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = now - doppler.config.startingTime;
  const duration = doppler.config.endingTime - doppler.config.startingTime;

  // Normalized time (0 to WAD)
  const normalizedTime = elapsed > 0n ? (elapsed * WAD) / duration : 0n;

  // Expected tokens sold (linear)
  const expectedSold = (normalizedTime * doppler.config.numTokensToSell) / WAD;

  // Sales ratio
  const actualSold = doppler.state.totalTokensSold;
  const salesRatio = expectedSold > 0n
    ? Number(actualSold * 10000n / expectedSold) / 10000
    : 0;

  // Migration check
  const canMigrate = doppler.status.earlyExit || (
    doppler.state.totalProceeds >= doppler.config.minimumProceeds &&
    now >= doppler.config.endingTime
  );

  return {
    // Progress
    timeProgress: Number(normalizedTime * 100n / WAD),  // percent
    currentEpoch: Number(doppler.status.currentEpoch),
    totalEpochs: Number(duration / doppler.config.epochLength),

    // Sales
    expectedSold: formatUnits(expectedSold, assetDecimals),
    actualSold: formatUnits(actualSold, assetDecimals),
    salesRatio,  // >1 = ahead of schedule, <1 = behind

    // Proceeds
    totalProceeds: formatUnits(doppler.state.totalProceeds, numeraireDecimals),
    minimumProceeds: formatUnits(doppler.config.minimumProceeds, numeraireDecimals),
    maximumProceeds: formatUnits(doppler.config.maximumProceeds, numeraireDecimals),
    proceedsProgress: Number(doppler.state.totalProceeds * 100n / doppler.config.minimumProceeds),

    // Status
    canMigrate,
    earlyExit: doppler.status.earlyExit,
    insufficientProceeds: doppler.status.insufficientProceeds,
  };
}
```

---

## Complete Verification Script

```javascript
// doppler-verify.mjs
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

// === CONFIGURATION ===
const HOOK_ADDRESS = '0x...';  // Doppler hook address
const POOL_ADDRESS = '0x...';  // Uniswap pool address
const ASSET_DECIMALS = 18;     // Token being sold
const NUMERAIRE_DECIMALS = 6;  // Payment token (e.g., USDC)

// === SETUP ===
const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL),
});

const WAD = 10n ** 18n;

// === UTILITY FUNCTIONS ===
function sqrtPriceX96ToPrice(sqrtPriceX96, token0Dec, token1Dec) {
  const Q96 = 2n ** 96n;
  const sqrtPrice = BigInt(sqrtPriceX96);
  const numerator = sqrtPrice * sqrtPrice;
  const denominator = Q96 * Q96;
  const decimalDiff = token0Dec - token1Dec;
  const PRECISION = 10n ** 18n;

  let priceScaled;
  if (decimalDiff >= 0) {
    priceScaled = (numerator * PRECISION * (10n ** BigInt(decimalDiff))) / denominator;
  } else {
    priceScaled = (numerator * PRECISION) / (denominator * (10n ** BigInt(-decimalDiff)));
  }
  return Number(priceScaled) / 1e18;
}

function tickToPrice(tick, token0Dec, token1Dec) {
  const price = Math.pow(1.0001, tick);
  return price * Math.pow(10, token0Dec - token1Dec);
}

// === MAIN ===
async function main() {
  console.log('=== Doppler Verification ===\n');

  // Read Doppler state
  const doppler = await readDopplerState(client, HOOK_ADDRESS);
  console.log('Configuration:', doppler.config);
  console.log('Status:', doppler.status);
  console.log('State:', doppler.state);

  // Analyze progress
  const progress = await analyzeAuctionProgress(
    client, HOOK_ADDRESS, ASSET_DECIMALS, NUMERAIRE_DECIMALS
  );
  console.log('\n=== Auction Progress ===');
  console.log(`Time: ${progress.timeProgress.toFixed(2)}%`);
  console.log(`Epoch: ${progress.currentEpoch} / ${progress.totalEpochs}`);
  console.log(`Expected Sold: ${progress.expectedSold}`);
  console.log(`Actual Sold: ${progress.actualSold}`);
  console.log(`Sales Ratio: ${progress.salesRatio.toFixed(4)} (${progress.salesRatio > 1 ? 'ahead' : 'behind'})`);
  console.log(`Proceeds: ${progress.totalProceeds} / ${progress.minimumProceeds} (${progress.proceedsProgress.toFixed(1)}%)`);
  console.log(`Can Migrate: ${progress.canMigrate}`);

  // Read pool price
  const pool = await readV3PoolState(client, POOL_ADDRESS);
  const price = sqrtPriceX96ToPrice(pool.sqrtPriceX96, ASSET_DECIMALS, NUMERAIRE_DECIMALS);
  console.log('\n=== Pool State ===');
  console.log(`sqrtPriceX96: ${pool.sqrtPriceX96}`);
  console.log(`Tick: ${pool.tick}`);
  console.log(`Price: ${price}`);
  console.log(`Liquidity: ${pool.liquidity}`);
}

main().catch(console.error);
```

---

## Tips

1. **Always use BigInt** for on-chain values to avoid precision loss
2. **Check token ordering** - token0 < token1 by address, affects price direction
3. **Use `formatUnits`** from viem for display, keep BigInt for calculations
4. **Batch reads with `Promise.all`** for efficiency
5. **Run with `node --experimental-modules`** if using older Node versions
