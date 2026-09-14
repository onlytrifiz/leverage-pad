# V4 Multicurve Auction Lifecycle

## Overview

```
┌────────────┐     ┌─────────────────┐     ┌───────────────┐
│ Initialize │ --> │  Static Trading │ --> │ Exit/Locked   │
│            │     │  (No Rebalance) │     │               │
└────────────┘     └─────────────────┘     └───────────────┘
    Curve setup        Passive swaps         Two paths:
    Position mint      Price discovery       - Migrable exit
    Status set                               - Permanent lock
```

## Phase 1: Initialization

### Step 1: Airlock calls initialize()
**Entry point**: `initialize(asset, numeraire, data)`
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 152-216)

```solidity
function initialize(
    address asset,
    address numeraire,
    bytes calldata data
) external override returns (address) {
    // 1. Decode parameters
    InitData memory initData = abi.decode(data, (InitData));

    // 2. Validate tick spacing
    isTickSpacingValid(initData.tickSpacing);

    // 3. Build PoolKey with token ordering
    PoolKey memory poolKey = PoolKey({
        currency0: asset < numeraire ? Currency.wrap(asset) : Currency.wrap(numeraire),
        currency1: asset < numeraire ? Currency.wrap(numeraire) : Currency.wrap(asset),
        hooks: IHooks(address(0)),
        fee: initData.fee,
        tickSpacing: initData.tickSpacing
    });
```

### Step 2: Curve Adjustment
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 173-175)

```solidity
bool isToken0 = Currency.unwrap(poolKey.currency0) == asset;
(Curve[] memory adjustedCurves, int24 farTick,) = Multicurve.adjustCurves(
    initData.curves, startingTick, initData.tickSpacing, isToken0
);
```

The `Multicurve.adjustCurves` function:
- Validates all curves
- Flips tick direction based on `isToken0`
- Computes `farTick` (exit trigger)
- Validates total shares = WAD

### Step 3: Position Calculation
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 177-180)

```solidity
Position[] memory positions = Multicurve.calculatePositions(
    adjustedCurves, initData.tickSpacing, numeraireBalance, assetBalance, isToken0
);
```

Creates all positions across all curves using log-normal distribution within each curve.

### Step 4: Pool Creation and Liquidity Minting
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 182-187)

```solidity
poolManager.initialize(poolKey, sqrtPriceX96);
poolManager.unlock(abi.encode(CallbackData({
    key: poolKey,
    sender: msg.sender,
    positions: positions
})));
```

### Step 5: Status Assignment
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 189-197)

```solidity
PoolStatus status = initData.beneficiaries.length != 0
    ? PoolStatus.Locked
    : PoolStatus.Initialized;

pools[PoolId.unwrap(poolKey.toId())] = PoolState({
    status: status,
    asset: asset,
    numeraire: numeraire,
    farTick: farTick,
    positions: positions
});
```

**Key distinction**: Beneficiaries present → Locked; Empty → Initialized (migrable)

## Phase 2: Static Trading

**No rebalancing occurs**. Unlike V4 dynamic auctions:
- No `beforeSwap` hook logic
- No tick accumulator
- No epoch tracking
- Price discovery happens passively through normal Uniswap swaps

## Phase 3: Exit Paths

### Path A: Migrable Exit (exitLiquidity)
**Available for**: Pools with `status == Initialized`
[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 218-252)

```solidity
function exitLiquidity(address asset) external returns (...) {
    PoolState memory state = getState[asset];
    require(state.status == PoolStatus.Initialized, PoolAlreadyExited());
    getState[asset].status = PoolStatus.Exited;

    token0 = Currency.unwrap(state.poolKey.currency0);
    token1 = Currency.unwrap(state.poolKey.currency1);

    (, int24 tick,,) = poolManager.getSlot0(state.poolKey.toId());
    int24 farTick = state.farTick;

    // Direction check: asset = token0 means tick must go UP; asset = token1 means tick must go DOWN
    require(asset == token0 ? tick >= farTick : tick <= farTick, CannotMigrateInsufficientTick());

    // Burn all positions and return tokens
    (BalanceDelta balanceDelta, BalanceDelta feesAccrued) = _burn(state.poolKey, state.positions);
    state.poolKey.currency0.transfer(msg.sender, balance0);
    state.poolKey.currency1.transfer(msg.sender, balance1);
}
```

[Source: UniswapV4MulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4MulticurveInitializer.sol) (lines 219-252)

**Exit condition**: Current tick must be at or beyond `farTick` in the direction that indicates the sale completed.

### Path B: Locked Pool (Permanent)
**Available for**: Pools with `status == Locked`

```
┌─────────────────────────────────────────────────┐
│                  LOCKED POOL                    │
│                                                 │
│  - Positions remain forever                     │
│  - Beneficiaries collect fees                   │
│  - exitLiquidity() reverts                      │
│  - migrate() not available                      │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Alternative Path: Migrator

The `UniswapV4MulticurveMigrator` provides an alternative initialization flow that goes through the `StreamableFeesLockerV2`:

[Source: UniswapV4MulticurveMigrator.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/migrators/UniswapV4MulticurveMigrator.sol) (lines 126-162)

```solidity
function migrate(
    uint160 sqrtPriceX96,
    address token0,
    address token1,
    address recipient
) external payable returns (uint256) {
    AssetData memory data = getAssetData[token0][token1];

    // Initialize pool
    poolManager.initialize(data.poolKey, sqrtPriceX96);

    // Calculate offset from current price
    int24 offset = TickMath.getTickAtSqrtPrice(sqrtPriceX96);

    // Adjust curves with offset (note: !isToken0)
    (Curve[] memory adjustedCurves,,) = Multicurve.adjustCurves(
        data.curves, offset, tickSpacing, !isToken0
    );

    // Calculate positions
    Position[] memory positions = Multicurve.calculatePositions(
        adjustedCurves, tickSpacing,
        isToken0 ? balance1 : balance0,
        isToken0 ? balance0 : balance1,
        !isToken0
    );

    // Transfer to locker
    currency0.transfer(address(locker), balance0);
    currency1.transfer(address(locker), balance1);

    // Lock positions
    locker.lock(data.poolKey, data.lockDuration, recipient, data.beneficiaries, positions);
}
```

### Migrator Flow

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│ Airlock     │ --> │ Migrator         │ --> │ Locker         │
│ migrate()   │     │ - init pool      │     │ - hold tokens  │
│             │     │ - calc positions │     │ - stream fees  │
└─────────────┘     └──────────────────┘     └────────────────┘
```

## Comparison with Other Lifecycle Types

| Phase | V3 Static | V4 Dynamic | V4 Multicurve |
|-------|-----------|----------|---------------|
| Init | Mint N positions | Place 3 slug types | Mint per-curve positions |
| Active | Static | Rebalance per epoch | Static |
| Exit trigger | Price at far tick | Proceeds thresholds | Price at far tick |
| Locked mode | Via Lockable variant | N/A | Via beneficiaries |
| Refund | N/A | Insufficient proceeds phase | N/A |
