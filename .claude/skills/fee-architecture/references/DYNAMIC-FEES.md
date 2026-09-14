# Dynamic Fees

Standard vs dynamic LP fee configuration in Doppler pools.

---

## Fee Modes

### Standard Fees

Fixed LP fee set at pool initialization. Cannot be changed after creation.

```solidity
PoolKey memory poolKey = PoolKey({
    currency0: ...,
    currency1: ...,
    fee: 3000,  // Fixed 0.3% fee
    tickSpacing: 60,
    hooks: IHooks(address(0))
});
```

### Dynamic Fees

Fee can be modified by the hook during pool lifetime.

```solidity
PoolKey memory poolKey = PoolKey({
    currency0: ...,
    currency1: ...,
    fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,  // Signals dynamic fee mode
    tickSpacing: 60,
    hooks: IHooks(dopplerHook)
});
```

[Source: UniswapV4Initializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/UniswapV4Initializer.sol) (lines 108)

---

## DYNAMIC_FEE_FLAG

A special value indicating the pool uses dynamic fees:

```solidity
// From Uniswap V4 LPFeeLibrary
uint24 constant DYNAMIC_FEE_FLAG = 0x800000;
```

When this flag is set:
- Initial fee is ignored
- Hook's `getFee()` determines swap fee
- Fee can be updated via `updateDynamicLPFee()`

---

## Updating Dynamic Fees

### updateDynamicLPFee()

The hook or authorized contract calls PoolManager:

```solidity
poolManager.updateDynamicLPFee(poolKey, newLpFee);
```

[Source: Doppler.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/Doppler.sol) (lines 371)

### In DopplerHookInitializer

```solidity
function updateDynamicLPFee(address asset, uint24 lpFee) external {
    PoolState memory state = getPoolState[asset];
    // Requires configured fee-updater authorization in deployment wiring.
    poolManager.updateDynamicLPFee(state.poolKey, lpFee);
}
```

[Source: DopplerHookInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/DopplerHookInitializer.sol) (lines 425-430)

---

## Fee Decay Schedule (Multicurve Decay Variant)

The decay multicurve path uses a hook-managed linear fee schedule:

- `startFee`: fee used at schedule start
- `fee` (end fee): terminal fee after decay completes
- `durationSeconds`: linear decay window
- `startingTime`: timestamp when decay begins

Validation constraints in the initializer/hook:

- `startFee <= MAX_LP_FEE`
- `fee <= MAX_LP_FEE`
- `startFee >= fee`
- If `startFee > fee`, `durationSeconds > 0`

Runtime behavior:

- At schedule set, the hook seeds pool fee to `startFee` via `updateDynamicLPFee`.
- Before `startingTime`, swaps are allowed and still execute at `startFee`.
- During decay, each `beforeSwap` computes the current fee and updates only when fee has dropped.
- After `startingTime + durationSeconds`, fee stays at terminal `fee`.

Linear interpolation:

```solidity
feeDelta = (startFee - endFee) * elapsed / durationSeconds;
currentFee = startFee - feeDelta;
```

[Source: DecayMulticurveInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/DecayMulticurveInitializer.sol) (lines 84-91, 126-127)  
[Source: DecayMulticurveInitializerHook.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/DecayMulticurveInitializerHook.sol) (lines 92-104, 128-146, 164-166)

---

## When to Use Each Mode

| Use Case | Fee Mode | Reason |
|----------|----------|--------|
| V3-style static pools | Standard | No hook overhead |
| V4 dynamic auctions | Dynamic | Hook needs fee control |
| Multicurve without hook | Standard | Simple fixed fee |
| Multicurve with DopplerHook | Dynamic | Hook manages fees |

---

## Initial LP Fee

For dynamic fee pools, an initial fee is set after initialization:

```solidity
// In Doppler.sol afterInitialize
poolManager.updateDynamicLPFee(key, initialLpFee);
```

[Source: Doppler.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/Doppler.sol) (lines 371)

This sets the starting fee before any swaps occur.

---

## Fee Validation

Uniswap V4 validates fees via LPFeeLibrary:

```solidity
// Maximum LP fee: 100%
uint24 constant MAX_LP_FEE = 1_000_000;

function validate(uint24 fee) internal pure {
    if (fee > MAX_LP_FEE) revert InvalidFee();
}
```

---

## Fee in V3 vs V4

| Aspect | V3 | V4 |
|--------|----|----|
| Fee storage | Per pool (immutable) | In PoolKey or dynamic |
| Fee tiers | Fixed (0.01%, 0.05%, 0.3%, 1%) | Any value 0-100% |
| Runtime changes | Not possible | Via hook |
| Tick spacing coupling | Yes (fee determines spacing) | No (independent) |

---

## DopplerHookInitializer Fee Logic

Pools with a DopplerHook use dynamic fees:

```solidity
PoolKey memory poolKey = PoolKey({
    // ...
    fee: initData.dopplerHook != address(0)
        ? LPFeeLibrary.DYNAMIC_FEE_FLAG  // Dynamic if hook present
        : initData.fee,                   // Standard if no hook
    // ...
});
```

[Source: DopplerHookInitializer.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/initializers/DopplerHookInitializer.sol) (lines 277)

---

## Insufficient Proceeds Fee Override

During insufficient proceeds phase, the Doppler hook overrides fees to 0:

```solidity
// In beforeSwap when insufficientProceeds = true
return (
    BaseHook.beforeSwap.selector,
    BeforeSwapDeltaLibrary.ZERO_DELTA,
    0  // Zero fee for refund swaps
);
```

This allows users to sell back tokens without paying fees during the refund period.
