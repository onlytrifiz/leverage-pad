# Cast Commands

Foundry's `cast` CLI for quick on-chain reads. Best for single-value queries and rapid debugging.

## Setup

```bash
# Install Foundry (if not installed)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Set RPC endpoint
export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
```

---

## Basic Patterns

### Read View Functions

```bash
# Generic pattern
cast call <CONTRACT> "functionName(args)(returnType)" [ARGS...] --rpc-url $ETH_RPC_URL

# With environment variable for RPC (recommended)
cast call $CONTRACT "balanceOf(address)(uint256)" $WALLET
```

### Read Storage Slots

```bash
# Direct slot read
cast storage <CONTRACT> <SLOT_NUMBER>

# Example: slot 0
cast storage $CONTRACT 0
```

### Decode Hex Values

```bash
cast --to-dec 0x1234      # Hex to decimal
cast --to-int256 0xff...   # Hex to signed int256
cast --from-wei 1000000000000000000  # Wei to ether
```

---

## Doppler V4 Dynamic Auction

### Read Configuration

```bash
# Token ordering
cast call $HOOK "isToken0()(bool)"

# Tick bounds
cast call $HOOK "startingTick()(int24)"
cast call $HOOK "endingTick()(int24)"

# Dynamic auction parameter
cast call $HOOK "gamma()(int24)"

# Time bounds
cast call $HOOK "startingTime()(uint256)"
cast call $HOOK "endingTime()(uint256)"
cast call $HOOK "epochLength()(uint256)"

# Sale parameters
cast call $HOOK "numTokensToSell()(uint256)"
cast call $HOOK "minimumProceeds()(uint256)"
cast call $HOOK "maximumProceeds()(uint256)"

# Terminal states
cast call $HOOK "earlyExit()(bool)"
cast call $HOOK "insufficientProceeds()(bool)"
```

### Read State

```bash
# Full state struct
cast call $HOOK "state()(uint40,int256,uint256,uint256,uint256,int128,int128)"

# Returns:
# [0] lastEpoch (uint40)
# [1] tickAccumulator (int256)
# [2] totalTokensSold (uint256)
# [3] totalProceeds (uint256)
# [4] totalTokensSoldLastEpoch (uint256)
# [5] feesAccrued.amount0 (int128)
# [6] feesAccrued.amount1 (int128)
```

### Read Computed Values

```bash
# Current epoch number
cast call $HOOK "getCurrentEpoch()(uint256)"

# Normalized time elapsed (0 to WAD)
cast call $HOOK "getNormalizedTimeElapsed(uint256)(uint256)" $(date +%s)

# Expected tokens sold (linear schedule)
cast call $HOOK "getExpectedAmountSold()(uint256)"

# Max tick change per epoch
cast call $HOOK "getMaxTickDeltaPerEpoch()(int256)"

# Current tick range from accumulator
cast call $HOOK "getTicksBasedOnState(int256,int24)(int24,int24)" $ACCUMULATOR $TICK_SPACING
```

### Read Positions

```bash
# Position struct: (tickLower, tickUpper, liquidity, salt)

# Lower slug (redemption)
cast call $HOOK "positions(bytes32)(int24,int24,uint128,uint8)" 0x0000000000000000000000000000000000000000000000000000000000000001

# Upper slug (current sales)
cast call $HOOK "positions(bytes32)(int24,int24,uint128,uint8)" 0x0000000000000000000000000000000000000000000000000000000000000002

# Price discovery slug 0
cast call $HOOK "positions(bytes32)(int24,int24,uint128,uint8)" 0x0000000000000000000000000000000000000000000000000000000000000003

# Number of PD slugs
cast call $HOOK "getNumPDSlugs()(uint256)"
```

---

## Doppler V3 Static Auction

### Read Initializer State

```bash
# Get pool state from initializer
cast call $INITIALIZER "getState(address)(address,address,int24,int24,uint16,bool,bool,uint256,uint256)" $POOL

# Returns:
# [0] token0
# [1] token1
# [2] tickLower
# [3] tickUpper
# [4] fee (in bps)
# [5] isToken0
# [6] isInitialized
# [7] maxShareToBeSold
# [8] maxShareToBond
```

---

## Uniswap Pool Queries

### V3 Pool slot0

```bash
cast call $POOL "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)"

# Returns:
# [0] sqrtPriceX96 (uint160)
# [1] tick (int24)
# [2] observationIndex
# [3] observationCardinality
# [4] observationCardinalityNext
# [5] feeProtocol
# [6] unlocked
```

### Pool Liquidity

```bash
cast call $POOL "liquidity()(uint128)"
```

### Pool Tokens

```bash
cast call $POOL "token0()(address)"
cast call $POOL "token1()(address)"
cast call $POOL "fee()(uint24)"
```

---

## Block-Specific Queries

```bash
# Read state at specific block
cast call $HOOK "state()" --block 18500000

# Get block timestamp
cast block 18500000 --field timestamp

# Get current block
cast block-number
```

---

## Transaction Analysis

### Decode Calldata

```bash
# Get function selector
cast sig "swap(address,bool,int256,uint160,bytes)"

# Decode calldata
cast calldata-decode "swap(address,bool,int256,uint160,bytes)" 0x...

# 4byte lookup
cast 4byte 0x128acb08
```

### Inspect Transaction

```bash
# Transaction details
cast tx 0xTX_HASH

# Specific fields
cast tx 0xTX_HASH --field input    # Calldata
cast tx 0xTX_HASH --field value    # ETH sent
cast tx 0xTX_HASH --field gasPrice

# Receipt with logs
cast receipt 0xTX_HASH
```

---

## Common Verification Commands

### Check Auction Progress

```bash
# Quick status check
echo "Epoch: $(cast call $HOOK 'getCurrentEpoch()(uint256)')"
echo "Sold: $(cast call $HOOK 'state()' | sed -n '3p') / $(cast call $HOOK 'numTokensToSell()(uint256)')"
echo "Proceeds: $(cast call $HOOK 'state()' | sed -n '4p')"
echo "Early Exit: $(cast call $HOOK 'earlyExit()(bool)')"
echo "Insufficient: $(cast call $HOOK 'insufficientProceeds()(bool)')"
```

### Check Migration Readiness

```bash
# Can migrate if:
# - earlyExit == true, OR
# - block.timestamp >= endingTime AND totalProceeds >= minimumProceeds

EARLY_EXIT=$(cast call $HOOK "earlyExit()(bool)")
INSUFFICIENT=$(cast call $HOOK "insufficientProceeds()(bool)")
ENDING_TIME=$(cast call $HOOK "endingTime()(uint256)")
MIN_PROCEEDS=$(cast call $HOOK "minimumProceeds()(uint256)")
PROCEEDS=$(cast call $HOOK "state()" | sed -n '4p')

echo "Early Exit: $EARLY_EXIT"
echo "Insufficient Proceeds: $INSUFFICIENT"
echo "Ending Time: $ENDING_TIME (now: $(date +%s))"
echo "Proceeds: $PROCEEDS / Min: $MIN_PROCEEDS"
```

### Verify Tick Alignment

```bash
# Get current tick and tick spacing
TICK=$(cast call $POOL "slot0()" | sed -n '2p')
TICK_SPACING=$(cast call $HOOK "tickSpacing()(int24)" 2>/dev/null || echo "Check pool for spacing")

# Tick should be divisible by spacing
echo "Tick: $TICK"
echo "Spacing: $TICK_SPACING"
# Aligned if: tick % tickSpacing == 0
```

---

## Event Topic Hashes

Use these to filter logs:

```bash
# Compute event signatures
cast sig-event "Rebalance(int24,int24,int24,uint256)"
# 0x...

cast sig-event "Swap(int24,uint256,uint256)"
# 0x...

cast sig-event "EarlyExit(uint256)"
# 0x...

cast sig-event "InsufficientProceeds()"
# 0x...
```

---

## Tips

1. **Use `--rpc-url` or `ETH_RPC_URL`** - Don't hardcode RPC endpoints
2. **Pipe to `sed` or `awk`** for extracting specific return values
3. **Use `--block`** for historical queries (requires archive node)
4. **Check `cast --help`** for more options
5. **Use `cast abi-encode`** to construct calldata for complex args
