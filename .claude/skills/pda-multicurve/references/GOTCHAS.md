# V4 Multicurve Auction Gotchas

Critical edge cases and common pitfalls when working with V4 multicurve auctions.

## 1. Share Sum Must Equal WAD Exactly

**The Problem**: Total shares across all curves must equal exactly `1e18` - no tolerance.

**The Code**:
```solidity
uint256 totalShares;
for (uint256 i; i < curves.length; ++i) {
    totalShares += curves[i].shares;
}
require(totalShares == WAD, InvalidTotalShares());
```
[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 95-99)

**Impact**:
- `0.999999999999999999e18` fails
- `1.000000000000000001e18` fails
- Only `1.000000000000000000e18` passes

**Mitigation**: Always calculate the last curve's shares as `WAD - sumOfOtherShares`.

---

## 2. Token Ordering / Tick Flipping (Same as V3/V4 Dynamic)

**The Problem**: Uniswap uses `token0 < token1` ordering. The `isToken0` flag determines all tick direction logic.

**The Code**:
```solidity
if (!isToken0) {
    (adjustedCurve.tickLower, adjustedCurve.tickUpper) =
        (-adjustedCurve.tickUpper, -adjustedCurve.tickLower);
}
```
[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 74-76)

**Impact**:
- Curves defined for token0 will have positions mirrored when used for token1
- Exit tick direction reverses
- All comparisons flip

---

## 3. Locked Pools Cannot Exit

**The Problem**: Once a pool has beneficiaries, it's permanently locked.

**The Code**:
```solidity
PoolStatus status = initData.beneficiaries.length != 0
    ? PoolStatus.Locked
    : PoolStatus.Initialized;
```
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 189-190)

**Impact**:
- `exitLiquidity()` will revert with `InvalidPoolStatus`
- Beneficiaries receive fees forever
- Liquidity cannot be withdrawn by anyone

**No recovery path** - this is intentional for fee-sharing arrangements.

---

## 4. Beneficiary Sorting Requirement

**The Problem**: Beneficiary addresses must be in ascending order.

**The Code**:
```solidity
require(
    beneficiaries[i].addr > beneficiaries[i - 1].addr,
    InvalidBeneficiaryAddress()
);
```
[Source: BeneficiaryData.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/types/BeneficiaryData.sol) (lines 58-61)

**Impact**: Unsorted beneficiaries cause initialization to revert.

**Mitigation**: Sort beneficiaries by address before calling initialize.

---

## 5. Protocol Owner Minimum 5%

**The Problem**: The protocol owner must receive at least 5% of fees.

**The Code**:
```solidity
uint256 constant MIN_PROTOCOL_OWNER_SHARES = 0.05e18;

if (protocolOwner == beneficiaries[i].addr) {
    require(
        beneficiaries[i].shares >= minProtocolOwnerShares,
        InvalidProtocolOwnerShares()
    );
}
```
[Source: BeneficiaryData.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/types/BeneficiaryData.sol) (lines 12, 70-74)

**Impact**: If protocol-owner shares < 5%, initialization reverts.

---

## 6. Migrator Uses !isToken0

**The Problem**: The migrator inverts the `isToken0` flag when calling `adjustCurves` and `calculatePositions`.

**The Code**:
```solidity
(Curve[] memory adjustedCurves,,) = Multicurve.adjustCurves(
    data.curves, offset, tickSpacing, !isToken0  // Note: !isToken0
);
Position[] memory positions = Multicurve.calculatePositions(
    adjustedCurves, tickSpacing,
    isToken0 ? balance1 : balance0,
    isToken0 ? balance0 : balance1,
    !isToken0  // Note: !isToken0
);
```
[Source: UniswapV4MulticurveMigrator.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/migrators/UniswapV4MulticurveMigrator.sol) (lines 148-151)

**Impact**: Curve definitions behave differently through migrator vs initializer.

**Mitigation**: Test curve configurations through the exact path they'll be used.

---

## 7. Position Skipping When StartingTick Equals FarTick

**The Problem**: Positions are silently skipped when the calculated starting tick equals the far tick.

**The Code**:
```solidity
if (startingTick != farTick) {
    // ... create position with liquidity
    positions[i] = Position({...});
}
// If equal, position is left uninitialized (zero liquidity)
```
[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 199-221)

**Impact**: Some positions may have zero liquidity if tick ranges align poorly.

**Mitigation**: Ensure curves have sufficient spread for the number of positions.

---

## 8. Tick Spacing Alignment Required

**The Problem**: Curve ticks must already be aligned to tick spacing - they're validated, not auto-aligned.

**The Code**:
```solidity
isTickAligned(adjustedCurve.tickLower, tickSpacing);
isTickAligned(adjustedCurve.tickUpper, tickSpacing);
```
[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 84-85)

**Impact**:
- `tickLower = 101` with `tickSpacing = 10` will **revert** (not round to 100)
- Curves must be pre-aligned before initialization

**Mitigation**: Pre-align ticks: `alignedTick = (tick / tickSpacing) * tickSpacing`

---

## 9. Salt Collisions Between Curves

**The Problem**: Position salts depend on curve index ordering. Changing curve order changes all salts.

**The Code**:
```solidity
positions[i].salt = bytes32(index * curve.numPositions + i);
```
[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 219)

**Impact**:
- Position identification depends on curve array order
- Cannot reorder curves without changing position salts
- May affect external systems tracking positions by salt

---

## 10. Far Tick Exit Direction

**The Problem**: Exit direction check depends on whether asset is token0.

**The Code**:
```solidity
require(asset == token0 ? tick >= farTick : tick <= farTick, CannotMigrateInsufficientTick(farTick, tick));
```
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 241)

**Impact**:
- For asset = token0: tick must be >= farTick (price went UP in token1 terms)
- For asset = token1: tick must be <= farTick (price went DOWN in token0 terms)
- Testing with wrong direction will never trigger exit

---

## 11. No Rebalancing or Dynamic Auction

**The Problem**: Unlike V4 dynamic, multicurve has no price adjustment mechanism.

**Impact**:
- If price doesn't reach curves naturally, tokens remain unsold
- No catch-up mechanism for slow sales
- No refund mechanism if sale fails

**Mitigation**: Design curves to cover expected price ranges.

---

## 12. Dust Token Handling

**The Problem**: Small rounding errors may leave dust tokens in the initializer.

**The Code** (from position calculation):
```solidity
uint256 amountPerPosition = curveSupply / numPositions;
```
[Source: Multicurve.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/libraries/Multicurve.sol) (lines 187)

**Impact**:
- `1000 tokens / 3 positions = 333 tokens each = 999 used, 1 dust`
- Dust typically returned to Airlock

---

## Comparison with Other Gotchas

| Gotcha | V3 Static | V4 Dynamic | V4 Multicurve |
|--------|-----------|----------|---------------|
| Token ordering | Same issue | Same issue | Same issue |
| Share validation | N/A | N/A | Exact WAD required |
| Locked pools | Separate contract | N/A | Via beneficiaries |
| Beneficiary sorting | N/A | N/A | Required |
| Protocol owner min | N/A | N/A | 5% minimum |
| Rebalancing | None | Every epoch | None |
| Exit condition | Far tick | Proceeds | Far tick |
| Refund mechanism | None | Insufficient proceeds | None |
