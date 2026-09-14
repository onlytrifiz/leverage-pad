---
name: rehypothecation-hook
description: Operate and configure Doppler's Rehype initializer hook for buybacks, beneficiary fees, fee routing, and protocol-owner fee claims.
license: MIT
metadata:
  author: doppler
  version: "2.0"
---

> **Source References**: Use [Doppler deployments](https://github.com/whetstoneresearch/doppler/tree/main/deployments) as the contract source of truth for deployed addresses and revisions.

# Rehypothecation Hook (Rehype)

## When to use
- Tasks mention Rehype, the rehypothecation hook, buybacks, beneficiary fee distribution, or `claimAirlockOwnerFees`
- You are troubleshooting hook-driven swap behavior for pools managed through `DopplerHookInitializer`

## Prerequisites
- Pool asset address
- Access to `DopplerHookInitializer.getState(asset)`
- Correct signer (`airlock.owner()` for protocol-owner fee claims)

## Core workflow
1. Resolve pool context and derive `poolId`.
   - Use `DopplerHookInitializer.getState(asset)`
2. Read hook state:
   - `getFeeDistributionInfo(poolId)`
   - `getHookFees(poolId)`
   - `getPoolInfo(poolId)`
   - `getFeeRoutingMode(poolId)`
   - `getFeeSchedule(poolId)`
3. Apply operation:
   - Collect beneficiary-directed fees with `collectFees(asset)`
   - Claim protocol-owner fees with `claimAirlockOwnerFees(asset)` from `airlock.owner()`
4. Validate storage resets and token balance deltas after each action.

## Quick facts
| Item | Detail |
|---|---|
| Supported hook | `RehypeDopplerHookInitializer` |
| Fee model | Decaying fee schedule via `getFeeSchedule(poolId)` |
| Distribution authority | Configured at initialization |
| Fee routing modes | `DirectBuyback`, `RouteToBeneficiaryFees` |
| Airlock owner share | Fixed 5% of the raw hook fee |
| Protocol-owner fee bucket | Claimable via `claimAirlockOwnerFees(asset)` |

## Failure modes
- Treating initializer-side Rehype as a static `customFee` hook instead of a fee-schedule hook
- Distribution does not sum to `WAD` (`1e18`, or 100%)
- Non-owner caller for protocol-owner fee claim
- Assuming fee distribution can be updated after initialization
- Confusing Rehype `beneficiaryFees` with initializer beneficiary-share accounting
- Assuming hook fees equal transferable balances without checking internal buckets

## References
- [CONFIGURATION.md](references/CONFIGURATION.md)
- Source: [RehypeDopplerHookInitializer.sol](https://github.com/whetstoneresearch/doppler/blob/74867435b00969c527eb7af618a31a53626cb05d/src/dopplerHooks/RehypeDopplerHookInitializer.sol), [RehypeTypes.sol](https://github.com/whetstoneresearch/doppler/blob/74867435b00969c527eb7af618a31a53626cb05d/src/types/RehypeTypes.sol), [RehypeDopplerHookInitializer.md](https://github.com/whetstoneresearch/doppler/blob/74867435b00969c527eb7af618a31a53626cb05d/docs/RehypeDopplerHookInitializer.md)

## Related skills
- [doppler-hooks](../doppler-hooks/SKILL.md)
- [fee-architecture](../fee-architecture/SKILL.md)
- [verification](../verification/SKILL.md)
