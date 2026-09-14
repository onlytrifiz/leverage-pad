# Configuration Guide

## Source of truth
- [RehypeDopplerHookInitializer.sol](https://github.com/whetstoneresearch/doppler/blob/74867435b00969c527eb7af618a31a53626cb05d/src/dopplerHooks/RehypeDopplerHookInitializer.sol)
- [RehypeTypes.sol](https://github.com/whetstoneresearch/doppler/blob/74867435b00969c527eb7af618a31a53626cb05d/src/types/RehypeTypes.sol)
- [RehypeDopplerHookInitializer.md](https://github.com/whetstoneresearch/doppler/blob/74867435b00969c527eb7af618a31a53626cb05d/docs/RehypeDopplerHookInitializer.md)

## Initializer-side configuration
Use this path for `RehypeDopplerHookInitializer`.

- Calldata layout (`abi.encode(...)` of `RehypeTypes.InitData`):
  1. `address numeraire`
  2. `address buybackDst`
  3. `uint24 startFee`
  4. `uint24 endFee`
  5. `uint32 durationSeconds`
  6. `uint32 startingTime`
  7. `FeeRoutingMode feeRoutingMode`
  8. `FeeDistributionInfo feeDistributionInfo`
- Validation:
  - `startFee <= MAX_SWAP_FEE` (currently `0.8e6`, or 80%)
  - `endFee <= MAX_SWAP_FEE` (currently `0.8e6`, or 80%)
  - `startFee >= endFee`
  - if `startFee > endFee`, `durationSeconds > 0`
  - each 4-field fee-distribution row must sum to `WAD` (`1e18`, or 100%)
  - `startingTime` is normalized to `block.timestamp` when passed as `0` or already in the past
- Operational note:
  - initializer-side Rehype does not use `getHookFees(poolId).customFee` as its fee source of truth
  - read `getFeeSchedule(poolId)` instead
- Operational note:
  - fee distribution is configured at initialization and is not customer-updated by an external admin call

## Beneficiary Fee Collection
1. Locate the Doppler asset address.
2. Call `collectFees(asset)` directly on the hook contract.
3. Resolve the pool through `DopplerHookInitializer.getState(asset)`.
4. Transfers accrued beneficiary fees to `buybackDst`.
5. Returned `BalanceDelta` indicates the amounts paid out; log it for accounting.

## Protocol Owner Fee Collection
The Rehype initializer hook tracks a protocol-owner fee bucket.

1. Fees accumulate in `getHookFees[poolId].airlockOwnerFees0` and `airlockOwnerFees1`.
2. Call `claimAirlockOwnerFees(asset)` from the current `airlock.owner()` address.
3. Only the current Airlock owner can claim this bucket.
4. Returns `(fees0, fees1)` indicating transferred amounts.

## Fee routing behavior
- `FeeRoutingMode.DirectBuyback` transfers buyback-designated outputs directly to `buybackDst`.
- `FeeRoutingMode.RouteToBeneficiaryFees` rolls those outputs into Rehype's internal `beneficiaryFees` buckets instead.
- Rehype beneficiary fees are internal hook accounting that is ultimately claimed to `buybackDst`.
- They are separate from beneficiary-share accounting managed by the initializer flow.

## Runtime notes
- Rehype takes a fixed 5% share of the raw hook fee for the Airlock owner, with the remaining 95% routed through buybacks, beneficiary accounting, and LP reinvestment.
- Routing only proceeds once accumulated `fees0` or `fees1` exceed `EPSILON` (currently `1e6`).
- LP-designated fees are rebalanced and added back into a full-range LP position instead of sitting idle.

## Operational Checklist
- Snapshot `getFeeDistributionInfo`, `getHookFees`, and `getPoolInfo` for the target pool.
- Snapshot `getFeeSchedule(poolId)` as well.
- Verify on-chain balances of the hook match `beneficiaryFees` to avoid payout underflows.
- Ensure `buybackDst` is set correctly, since it multiplexes both buybacks and beneficiary payouts.
- Confirm the initialized fee schedule before assuming current fee behavior.
- If protocol-owner fee claiming is part of your flow, confirm `airlock.owner()` before calling `claimAirlockOwnerFees(asset)`.
