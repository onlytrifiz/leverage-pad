# State Map

## Core structs
- `InitData`:
  - `fee`, `tickSpacing`, `farTick`, `curves`, `beneficiaries`
  - `dopplerHook`
  - callback calldata for initialization and graduation
- `PoolState`:
  - `numeraire`, `beneficiaries`, `adjustedCurves`
  - `totalTokensOnBondingCurve`
  - `dopplerHook`, `graduationDopplerHookCalldata`
  - `status`, `poolKey`, `farTick`

## Status enum
- `Uninitialized`
- `Initialized`
- `Locked`
- `Graduated`
- `Exited`

## Operational mappings
- `getState(asset)`
- `isDopplerHookEnabled(hook)`
