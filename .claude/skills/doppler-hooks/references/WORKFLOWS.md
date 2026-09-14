# Workflows

## 1) Initialize hook-enabled pool
- In `InitData`, set:
  - `dopplerHook`
  - `onInitializationDopplerHookCalldata`
  - `graduationDopplerHookCalldata`
- If hook is nonzero, ensure it is enabled in `isDopplerHookEnabled` for the target deployment.

## 2) Validate runtime behavior
- Read `getState(asset)` and derive `poolKey`/`poolId`.
- Confirm callbacks are firing for expected events.
- For swap-time behavior, inspect hook-specific storage (`ScheduledLaunchDopplerHook`, `SwapRestrictorDopplerHook`, `RehypeDopplerHookInitializer`).

## 3) Graduation and migration checks
- Verify status progression and tick/proceeds conditions before exit/migrate calls.
- If `graduationDopplerHookCalldata` is required, confirm encoding.
