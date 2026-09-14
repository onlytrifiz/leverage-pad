# Multicurve Variants

## Base variant
- Contract: `src/initializers/UniswapV4MulticurveInitializer.sol`
- **Deprecated for new integrations**.
- Retained for legacy compatibility only.
- Prefer scheduled multicurve with `startingTime = 0` instead.

## Scheduled variant
- Contracts:
  - `src/initializers/UniswapV4ScheduledMulticurveInitializer.sol`
  - `src/initializers/UniswapV4ScheduledMulticurveInitializerHook.sol`
- Adds `startingTime` in init data and enforces schedule via hook state.
- **Canonical default variant** for new integrations.
- Use `startingTime = 0` for immediate launch behavior.

## Decay variant
- Contracts:
  - `src/initializers/DecayMulticurveInitializer.sol`
  - `src/initializers/DecayMulticurveInitializerHook.sol`
- Uses dynamic fee flag and linear fee descent (`startFee -> fee`) over `durationSeconds`.
- Enforces `startFee >= fee` and caps fee with `MAX_LP_FEE` in the initializer path.
- Choose only when fee-decay behavior is explicitly required.

## Test anchors
- `test/integration/V4MulticurveInitializer.t.sol`
- `test/integration/V4ScheduledMulticurveInitializer.t.sol`
- `test/integration/V4DecayMulticurveInitializer.t.sol`
- `test/integration/DecayMulticurveInitializer.t.sol`
