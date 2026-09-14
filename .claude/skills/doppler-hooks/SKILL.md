---
name: doppler-hooks
description: Integrate and verify Doppler hook modules, including `DopplerHookInitializer` hook paths, callback flags, and hook-specific runtime behavior.
license: MIT
metadata:
  author: doppler
  version: "1.0"
---

> **Source References**: Use [Doppler deployments](https://github.com/whetstoneresearch/doppler/tree/main/deployments) as the contract source of truth for deployed addresses and revisions.

# Doppler Hooks

## When to use
- You need a top-level hook integration path for a price discovery launch
- You are using `DopplerHookInitializer` to register or manage hook callbacks
- You are troubleshooting hook-enabled multicurve pools and lifecycle transitions

## Prerequisites
- Asset/numeraire addresses and expected pool mode (locked vs migrable)
- Hook contract addresses and intended flags

## Core workflow
1. Initialize pool with `InitData` including optional `dopplerHook` and callback calldata.
2. Confirm stored state via `getState(asset)`:
   - pool key
   - far tick
   - status
   - selected hook
3. Validate callback execution path by flag:
   - `ON_INITIALIZATION_FLAG`
   - `ON_SWAP_FLAG`
   - `ON_GRADUATION_FLAG`
4. Verify graduation / migration behavior for the configured hook path.

## Supported hook modules
- Rehypothecation hook (`RehypeDopplerHookInitializer`) for buybacks, fee routing, and protocol-owner fee claims
- `ScheduledLaunchDopplerHook` for start-time gates
- `SwapRestrictorDopplerHook` for per-address amount ceilings

## Quick facts
| Item | Detail |
|---|---|
| Initializer contract | `DopplerHookInitializer` |
| Base hook contract | `BaseDopplerHook` |
| Core callback flags | `ON_INITIALIZATION_FLAG`, `ON_SWAP_FLAG`, `ON_GRADUATION_FLAG` |
| Common module | Rehypothecation hook (`RehypeDopplerHookInitializer`) |

## Failure modes
- Hook module not enabled for the target deployment
- Incorrect callback calldata encoding
- Status mismatch (`WrongPoolStatus` cases)
- Attempting migration without graduation conditions met

## References
- [WORKFLOWS.md](references/WORKFLOWS.md)
- [STATE-MAP.md](references/STATE-MAP.md)
- Source: `doppler/src/initializers/DopplerHookInitializer.sol`, `doppler/src/base/BaseDopplerHook.sol`, `doppler/docs/DopplerHookInitializer.md`

## Related skills
- [rehypothecation-hook](../rehypothecation-hook/SKILL.md)
- [pda-multicurve](../pda-multicurve/SKILL.md)
- [verification](../verification/SKILL.md)
