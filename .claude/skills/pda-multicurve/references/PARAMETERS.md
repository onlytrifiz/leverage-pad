# V4 Multicurve Auction Parameters

## Curve Struct

Each curve defines an independent liquidity distribution:

```solidity
struct Curve {
    int24 tickLower;      // Lower tick bound of the curve
    int24 tickUpper;      // Upper tick bound of the curve
    uint16 numPositions;  // Number of positions within this curve
    uint256 shares;       // WAD fraction of total tokens for this curve
}
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 29-34)

### Curve Fields

| Field | Type | Description |
|-------|------|-------------|
| `tickLower` | `int24` | Starting tick for this curve's positions |
| `tickUpper` | `int24` | Ending tick for this curve's positions |
| `numPositions` | `uint16` | How many positions to create within the range |
| `shares` | `uint256` | Fraction of tokens (scaled by 1e18) |

## InitData Struct

Configuration passed to the initializer:

```solidity
struct InitData {
    uint24 fee;
    int24 tickSpacing;
    Curve[] curves;
    BeneficiaryData[] beneficiaries;
}
```

[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 49-54)

### InitData Fields

| Field | Type | Description |
|-------|------|-------------|
| `fee` | `uint24` | Pool swap fee (e.g., 3000 = 0.3%) |
| `tickSpacing` | `int24` | Tick spacing for the pool |
| `curves` | `Curve[]` | Array of curve configurations |
| `beneficiaries` | `BeneficiaryData[]` | Fee recipients (empty = Migrable) |

## PoolStatus Enum

Tracks the lifecycle state of each pool:

```solidity
enum PoolStatus {
    Uninitialized,  // 0: Pool not yet created
    Initialized,    // 1: Pool created, no beneficiaries (migrable)
    Locked,         // 2: Pool created with beneficiaries (permanent)
    Exited          // 3: Liquidity has been withdrawn
}
```

[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 57-62)

### Status Transitions

```
Uninitialized ──► Initialized ──► Exited
              │
              └─► Locked (permanent, no exit)
```

## PoolState Struct

Runtime state per pool:

```solidity
struct PoolState {
    PoolStatus status;          // Current lifecycle status
    address asset;              // Token being sold
    address numeraire;          // Token being received
    int24 farTick;              // Exit trigger tick
    Position[] positions;       // All liquidity positions
}
```

[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 73-80)

## BeneficiaryData Struct

Fee recipient configuration (for Locked pools):

```solidity
struct BeneficiaryData {
    address addr;      // Beneficiary address
    uint256 shares;    // Share of fees (WAD-scaled)
}
```

[Source: BeneficiaryData.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/types/BeneficiaryData.sol) (lines 17-20)

### Beneficiary Constraints

1. **Addresses must be sorted** in ascending order
2. **Protocol owner must have >= 5%** (`MIN_PROTOCOL_OWNER_SHARES = 0.05e18`)
3. **Shares must sum to WAD** (1e18)

[Source: BeneficiaryData.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/types/BeneficiaryData.sol) (lines 43-79)

## Share Constraints

**Critical**: All curve shares must sum to exactly WAD (1e18):

```solidity
uint256 totalShares;
for (uint256 i; i < curves.length; ++i) {
    totalShares += curves[i].shares;
}
require(totalShares == WAD, InvalidTotalShares());
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 95-99)

No tolerance - exact equality required.

## Migrator Parameters

The migrator accepts additional parameters:

```solidity
struct AssetData {
    bool isToken0;              // Is currency0 the asset being sold
    PoolKey poolKey;            // Uniswap V4 pool key
    uint32 lockDuration;        // Lock period in seconds
    Curve[] curves;             // Curve configurations
    BeneficiaryData[] beneficiaries;  // Fee recipients
}
```

[Source: UniswapV4MulticurveMigrator.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/migrators/UniswapV4MulticurveMigrator.sol) (lines 30-36)

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `WAD` | `1e18` | Precision multiplier for shares |
| `MIN_PROTOCOL_OWNER_SHARES` | `0.05e18` | Minimum 5% for protocol owner |

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 16), [Source: BeneficiaryData.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/types/BeneficiaryData.sol) (lines 12)

## Comparison with Other Auction Types

| Parameter | V3 Static | V4 Dynamic | V4 Multicurve |
|-----------|-----------|----------|---------------|
| Positions | `numPositions` | 3 slugs + PD | Per-curve `numPositions` |
| Allocation | Linear | Dynamic | Shares-based |
| Fee config | Fixed at init | Dynamic | Fixed at init |
| Tick range | Single | Adjusting | Per-curve |
| Exit config | N/A | Proceeds thresholds | Beneficiaries |

---

## Far Tick (farTick)

The farthest tick that must be reached before a pool can graduate or migrate. This is the migration trigger for tick-based exit.

### Definition

```solidity
// In InitData
int24 farTick;  // Farthest tick to allow exiting liquidity

// In PoolState
int24 farTick;  // Stored for migration check
```

[Source: DopplerHookInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/DopplerHookInitializer.sol) (lines 118,129,167)

### Direction Logic

**farTick direction depends on `isToken0`**:

| isToken0 | Selling | farTick direction | Migration check |
|----------|---------|-------------------|-----------------|
| `true` | token0 | Higher tick (price up in token1) | `tick >= farTick` |
| `false` | token1 | Lower tick (negated on init) | `tick <= farTick` |

### Validation

```solidity
// When isToken0 = true
require(farTick >= startTick && farTick <= upperTickBoundary, UnreachableFarTick());

// When isToken0 = false (farTick is negated)
farTick = -farTick;
require(farTick <= startTick && farTick >= lowerTickBoundary, UnreachableFarTick());
```

[Source: DopplerHookInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/DopplerHookInitializer.sol) (lines 287-294)

### Migration Check

Pool can only migrate when current tick has reached or passed farTick:

```solidity
// In _canGraduateOrMigrate
require(
    isToken0 ? tick >= farTick : tick <= farTick,
    CannotMigrateInsufficientTick(farTick, tick)
);
```

[Source: DopplerHookInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/DopplerHookInitializer.sol) (lines 488-492)

### Migrable vs Locked Pools

| Pool Type | farTick Role |
|-----------|--------------|
| Migrable (no beneficiaries) | Must reach farTick to exit |
| Locked (with beneficiaries) | Pool never exits, farTick unused |

**See also**: [fee-architecture](../../fee-architecture/SKILL.md) for beneficiary fee streaming in locked pools
