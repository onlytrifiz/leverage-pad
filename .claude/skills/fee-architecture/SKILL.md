---
name: fee-architecture
description: Reference for Doppler fee collection, distribution, and configuration across Airlock, FeesManager, locker contracts, and hook-based fee paths.
license: MIT
metadata:
  author: doppler
  version: "2.0"
---

> **Source References**: Use [Doppler deployments](https://github.com/whetstoneresearch/doppler/tree/main/deployments) as the contract source of truth for deployed addresses and revisions.

# Fee Architecture

## When to use
- You need to explain where fees are tracked and how payouts are derived
- You are debugging fee outcomes across migration and beneficiary paths
- You are changing LP fee configuration or hook-driven fee behavior
- You are validating multicurve fee decay configuration (`startFee`, `fee`, `durationSeconds`, `startingTime`)

## Prerequisites
- Identify sale path (static, dynamic, multicurve, or hook-initialized multicurve path)
- Identify whether pool is locked (beneficiaries enabled) or migrable

## Core workflow
1. Identify fee surfaces in the flow:
    - Swap-time LP fees (pool/hook context)
    - Migration-time proceeds accounting in `Airlock`
    - Beneficiary fee tracking in `FeesManager` / locker modules
2. Confirm storage location for each fee bucket:
    - `Airlock` fee accounting mappings
    - `RehypeDopplerHookInitializer` fee buckets
    - Locker/initializer `collectFees` paths for beneficiaries
3. Validate claim paths for each actor (beneficiary, buyback destination, integrator, or protocol owner).
4. Reconcile balances before and after claims on-chain.

## Quick facts
| Fee type | Primary location | Typical claim path |
|---|---|---|
| Protocol/integrator accounting | `src/Airlock.sol` | `collectProtocolFees(...)`, `collectIntegratorFees(...)` |
| Beneficiary fees (initializer/locker) | `src/base/FeesManager.sol`, locker modules | `collectFees(...)` |
| `RehypeDopplerHookInitializer` beneficiary + protocol-owner buckets | `src/dopplerHooks/RehypeDopplerHookInitializer.sol` | `collectFees(asset)`, `claimAirlockOwnerFees(asset)` |

## Failure modes
- Wrong signer for beneficiary claim/update methods
- Wrong signer for protocol/integrator claim methods
- Using stale pool status assumptions (`Initialized` vs `Locked`/`Graduated`)
- Confusing proceeds split logic with LP fee accounting
- Confusing Rehype internal `beneficiaryFees` with initializer or locker beneficiary-share accounting
- Treating V2-only mechanics as active defaults

## References
- [COLLECTION.md](references/COLLECTION.md)
- [DISTRIBUTION.md](references/DISTRIBUTION.md)
- [DYNAMIC-FEES.md](references/DYNAMIC-FEES.md)
- Source: `doppler/src/Airlock.sol`, `doppler/src/base/FeesManager.sol`, `doppler/src/StreamableFeesLockerV2.sol`, `doppler/src/dopplerHooks/RehypeDopplerHookInitializer.sol`, `doppler/src/types/RehypeTypes.sol`

## Related skills
- [airlock](../airlock/SKILL.md)
- [rehypothecation-hook](../rehypothecation-hook/SKILL.md)
- [pda-dynamic](../pda-dynamic/SKILL.md)
- [pda-multicurve](../pda-multicurve/SKILL.md)
- [proceeds-split-migration](../proceeds-split-migration/SKILL.md)
