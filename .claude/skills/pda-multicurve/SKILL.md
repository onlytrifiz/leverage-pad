---
name: pda-multicurve
description: Reference for multicurve price discovery auctions with scheduled multicurve as the canonical default; covers shares-based curve allocation, deployment modes, and lifecycle constraints.
license: MIT
metadata:
  author: doppler
  version: "2.0"
---

> **Source References**: Use [Doppler deployments](https://github.com/whetstoneresearch/doppler/tree/main/deployments) as the contract source of truth for deployed addresses and revisions.

# Multicurve Price Discovery Auction

## Suggested profile
- Asset tier: low/medium-value assets
- Curve posture: predictable supply curves
- Governance: `OpenZeppelin Governor: disabled`
- Migration: none
- Hook path: `DopplerHookInitializer` + `RehypeDopplerHookInitializer`
- Beneficiaries: custom fee beneficiary setup
- Preallocation: 3 addresses
- Market posture: widely supported in production flows; commonly used by teams including Zora and Bankr

## When to use
- You are configuring the default launch path for most assets
- You need curve share math and position distribution behavior
- You need deployment-mode semantics (non-migrating vs migrable/locked)

## Prerequisites
- Decide governance mode as a product choice:
  - `OpenZeppelin Governor: disabled` (default)
  - `OpenZeppelin Governor: enabled` (only when token-holder governance is required)
- Use `3-5` supply curves for most launches
- Include a tail position from max-curve to infinity (SDK `max` keyword)
- Use scheduled multicurve by default with `startingTime = 0`
- Use decay multicurve only when you explicitly need fee decay behavior (`startFee -> fee`)
- Treat base multicurve as deprecated for new integrations (legacy support only)

## Core workflow
1. Build `Curve[]` with `3-5` supply curves, including the max-tail curve to infinity.
2. Validate curve shares sum to `WAD` and all ticks align to `tickSpacing`.
3. Choose deployment mode:
   - Default: non-migrating launch path
   - Advanced: migrable/locked lifecycle paths when required
4. Configure hook initializer and module path (`DopplerHookInitializer` + `RehypeDopplerHookInitializer`) with beneficiary fee routing and the intended Rehype fee schedule.
5. Initialize pool with scheduled multicurve (`UniswapV4ScheduledMulticurveInitializer`) and set `startingTime = 0` unless delayed launch gating is intentional.
6. Verify lifecycle path, preallocation recipients, and claims flow for the chosen mode.

## Quick facts
| Item | Detail |
|---|---|
| Main contracts | `UniswapV4ScheduledMulticurveInitializer` (default), `DecayMulticurveInitializer` (conditional), `UniswapV4MulticurveInitializer` (legacy/deprecated for new integrations) |
| Allocation model | Shares-based across independent curves |
| Rebalancing | None (static positions) |
| Hook variants | Scheduled start-time hook, decay fee-schedule hook |
| Default posture | No governance, no migration, `3-5` curves + max tail + scheduled variant with `startingTime = 0` |

## Failure modes
- Curve shares not summing to `WAD`
- Missing max-tail position (`max` curve to infinity)
- Tick spacing misalignment
- Using base multicurve instead of scheduled multicurve for new integrations
- Setting nonzero `startingTime` unintentionally and delaying launch start
- Choosing migrable lifecycle when non-migrating posture is intended
- Wrong assumptions about scheduled start or decaying fee behavior

## References
- [PARAMETERS.md](references/PARAMETERS.md)
- [FLOW.md](references/FLOW.md)
- [FORMULAS.md](references/FORMULAS.md)
- [GOTCHAS.md](references/GOTCHAS.md)
- [VARIANTS.md](references/VARIANTS.md)

## Related skills
- [pda-dynamic](../pda-dynamic/SKILL.md)
- [doppler-hooks](../doppler-hooks/SKILL.md)
- [fee-architecture](../fee-architecture/SKILL.md)
- [verification](../verification/SKILL.md)
