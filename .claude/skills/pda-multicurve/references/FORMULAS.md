# V4 Multicurve Auction Formulas

## Share-Based Token Allocation

Each curve receives tokens proportional to its share:

```solidity
uint256 curveSupply = FullMath.mulDiv(supply, curves[index].shares, WAD);
```

**Formula**: `curveSupply = totalSupply * shares / 1e18`

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 143-145)

**Example**: If curve has `0.3e18` shares and `1000` total tokens:
- `curveSupply = 1000 * 0.3e18 / 1e18 = 300 tokens`

## Share Validation

All curve shares must sum to exactly WAD:

```solidity
uint256 totalShares;
for (uint256 i; i < curves.length; ++i) {
    totalShares += curves[i].shares;
}
require(totalShares == WAD, InvalidTotalShares());
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 95-99)

**No tolerance** - exact equality to `1e18` required.

## Curve Adjustment

Curves are adjusted based on starting tick and token direction:

```solidity
function adjustCurves(
    Curve[] memory curves,
    int24 startingTick,
    int24 tickSpacing,
    bool isToken0
) internal pure returns (
    Curve[] memory adjustedCurves,
    int24 farTick,
    int24 startTick
)
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 46-100)

### Tick Flipping for Token1

When `isToken0 == false`, ticks are negated and swapped:

```solidity
if (!isToken0) {
    (adjustedCurve.tickLower, adjustedCurve.tickUpper) =
        (-adjustedCurve.tickUpper, -adjustedCurve.tickLower);
}
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 74-76)

**Formula**: `newLower = -oldUpper`, `newUpper = -oldLower`

This mirrors positions around tick 0, then the offset is applied.

## Far Tick Calculation

The `farTick` is the outermost tick across all curves (exit trigger):

```solidity
if (isToken0) {
    if (curves[i].tickLower < farTick) {
        farTick = curves[i].tickLower;
    }
} else {
    if (curves[i].tickUpper > farTick) {
        farTick = curves[i].tickUpper;
    }
}
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 81-88)

## Log-Normal Distribution

Positions within each curve are distributed linearly by tick:

```solidity
function calculateLogNormalDistribution(
    Curve memory curve,
    uint256 index,
    int24 tickSpacing,
    uint256 supply,
    uint256 otherCurrencySupply,
    bool isToken0
) internal pure returns (Position[] memory positions)
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 173-225)

### Position Tick Calculation

Each position's starting tick is calculated proportionally:

```solidity
int24 startingTick = isToken0
    ? closeTick + int24(uint24(FullMath.mulDiv(i, uint256(uint24(spread)), numPositions)))
    : closeTick - int24(uint24(FullMath.mulDiv(i, uint256(uint24(spread)), numPositions)));

// Round the tick to the nearest bin
startingTick = alignTick(isToken0, startingTick, tickSpacing);
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 192-197)

### Liquidity Calculation

Each position gets equal share of the curve's supply:

```solidity
uint256 amountPerPosition = curveSupply / numPositions;

liquidity = isToken0
    ? LiquidityAmounts.getLiquidityForAmount0(startingSqrtPriceX96, farSqrtPriceX96, amountPerPosition - 1)
    : LiquidityAmounts.getLiquidityForAmount1(farSqrtPriceX96, startingSqrtPriceX96, amountPerPosition - 1);
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 187, 206-212)

**Note**: `amountPerPosition - 1` is used to avoid rounding errors.

## Position Salt (Uniqueness)

Each position has a unique salt for identification:

```solidity
positions[i].salt = bytes32(index * curve.numPositions + i);
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 219)

**Formula**: `salt = curveIndex * numPositionsInCurve + positionIndex`

**Example**:
- Curve 0, Position 0: salt = 0
- Curve 0, Position 1: salt = 1
- Curve 1 (10 positions in curve 0), Position 0: salt = 10
- Curve 1, Position 1: salt = 11

## Tail Position

### What is a Tail Position?

The tail position is a **conditional LP position** extending beyond the bonding curves to the pool's tick boundaries. Unlike V3 static auctions (which always create 1 tail), multicurve auctions only create a tail if there's remaining token supply.

**Purpose**:
1. **Continuous liquidity**: Provides liquidity beyond curve ranges
2. **Reserve deployment**: Uses remaining tokens after curve allocation
3. **V2 price parity**: Bridges concentrated positions with constant-product pricing

### Conditional Creation

Tail positions are only created if there's remaining supply:

```solidity
// If there's any supply of the other currency, we can compute the head position
// using the inverse logic of the tail
if (otherCurrencySupply > 0) {
    Position memory headPosition = calculateLpTail(
        bytes32(positions.length),
        lowerTickBoundary,
        upperTickBoundary,
        !isToken0,           // NOTE: inverted token direction
        otherCurrencySupply,
        tickSpacing
    );

    if (headPosition.liquidity > 0) {
        positions = concat(positions, new Position[](1));
        positions[positions.length - 1] = headPosition;
    }
}
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 146-156)

**Key insight**: The "head position" uses `!isToken0` (inverse token logic), creating a tail-like position for the non-selling token.

### calculateLpTail() Function

```solidity
function calculateLpTail(
    bytes32 salt,
    int24 tickLower,
    int24 tickUpper,
    bool isToken0,
    uint256 supply,
    int24 tickSpacing
) pure returns (Position memory lpTail)
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 238-245)

### Tail Tick and Position Range

```solidity
int24 tailTick = isToken0 ? tickUpper : tickLower;

int24 posTickLower = isToken0 ? tailTick + tickSpacing : alignTick(isToken0, TickMath.MIN_TICK, tickSpacing);
int24 posTickUpper = isToken0 ? alignTick(isToken0, TickMath.MAX_TICK, tickSpacing) : tailTick - tickSpacing;
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 246-250)

**Key difference from V3**: Multicurve applies `±tickSpacing` offset from the far tick:

| Selling | V3 Tail Range | V4 Multicurve Tail Range |
|---------|---------------|--------------------------|
| Token0 | `[tickUpper, MAX_TICK]` | `[tickUpper + tickSpacing, MAX_TICK]` |
| Token1 | `[MIN_TICK, tickLower]` | `[MIN_TICK, tickLower - tickSpacing]` |

### Tail Liquidity Calculation

```solidity
uint128 lpTailLiquidity = LiquidityAmounts.getLiquidityForAmounts(
    sqrtPriceAtTail,
    TickMath.getSqrtPriceAtTick(posTickLower),
    TickMath.getSqrtPriceAtTick(posTickUpper),
    isToken0 ? supply - 1 : 0,
    isToken0 ? 0 : supply - 1
);
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 252-258)

**Note**: `supply - 1` provides rounding protection, ensuring the tail position can always be minted.

### V3 vs V4 Multicurve Tail Comparison

| Aspect | V3 Static | V4 Multicurve |
|--------|-----------|---------------|
| Always created | Yes (1 per pool) | Conditional (if supply > 0) |
| Called | `calculateLpTail()` | `calculateLpTail()` |
| Offset from far tick | None (exact boundary) | ±tickSpacing |
| Token source | `bondingAssetsRemaining` + reserves | `otherCurrencySupply` |
| Rounding protection | Reserves undercounted | `supply - 1` |
| "Head" position | N/A | Uses `!isToken0` for inverse direction |

## Tick Alignment

Similar to V3 and V4 dynamic, ticks must align to tick spacing:

```solidity
// Round to nearest tick spacing multiple
curve.tickLower = (curve.tickLower / tickSpacing) * tickSpacing;
curve.tickUpper = (curve.tickUpper / tickSpacing) * tickSpacing;
```

[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 62-65)

## Migrator Offset Calculation

The migrator calculates offset from the current price:

```solidity
int24 offset = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
(Curve[] memory adjustedCurves,,) = adjustCurves(
    data.curves, offset, tickSpacing, !isToken0
);
```

[Source: UniswapV4MulticurveMigrator.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/migrators/UniswapV4MulticurveMigrator.sol) (lines 147-148)

**Note**: The migrator passes `!isToken0` to `adjustCurves`.

## Comparison with Other Formula Sets

| Formula | V3 Static | V4 Dynamic | V4 Multicurve |
|---------|-----------|----------|---------------|
| Token allocation | Linear across N positions | Per-slug calculation | Shares-based per curve |
| Position distribution | Linear by tick | 3 slug types | Linear within each curve |
| Tick adjustment | Starting tick alignment | Accumulator-based | Curve flipping for token1 |
| Liquidity calc | Amount/numPositions | Per-slug requirements | Per-position within curve |
