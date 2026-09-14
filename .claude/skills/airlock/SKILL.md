---
name: airlock
description: Canonical reference for `Airlock` as Doppler's protocol entrypoint, including launch orchestration, migration handoff, and interface coverage.
license: MIT
metadata:
  author: doppler
  version: "1.0"
---

> **Source References**: Use [Doppler deployments](https://github.com/whetstoneresearch/doppler/tree/main/deployments) as the contract source of truth for deployed addresses and revisions.

# Airlock Entrypoint

**Requirement**: every Doppler user integrates through `Airlock`. Direct integration to downstream modules is not the canonical user path.

## When to use
- You are integrating with Doppler (all integrations are Airlock-first).
- You need to reason about how token factory, initializer, and migrator contracts are coordinated.
- You need a single source for Airlock behavior and its externally-consumable interface.

## What Airlock does
- Entry point for launch creation (`create(...)` path).
- Lifecycle coordinator for migration (`migrate(asset)` path).

## Orchestration model
1. `create(...)` receives launch configuration and selects modules.
2. Airlock routes token deployment to the selected token factory.
3. Airlock routes pool setup to the selected initializer.
4. Airlock executes migration handoff through the configured liquidity migrator.

## Core workflow
1. Validate module addresses and config payloads.
2. Execute launch creation through Airlock.
3. Track status through initializer/migrator state and emitted events.
4. Call `migrate(asset)` when exit conditions are satisfied.
5. Reconcile migration outputs and downstream pool state.

## Quick facts
| Item | Detail |
|---|---|
| Canonical contract | `src/Airlock.sol` |
| Launch entrypoint | `create(...)` |
| Migration entrypoint | `migrate(asset)` |

## References
- [ENTRYPOINT.md](references/ENTRYPOINT.md)
- [INTERFACE.md](references/INTERFACE.md)
- Source: `doppler/src/Airlock.sol`

## Related skills
- [token-lifecycle](../token-lifecycle/SKILL.md)
- [migrator-uniswap-v2](../migrator-uniswap-v2/SKILL.md)
- [migrator-uniswap-v3](../migrator-uniswap-v3/SKILL.md)
- [migrator-uniswap-v4](../migrator-uniswap-v4/SKILL.md)
- [pda-multicurve](../pda-multicurve/SKILL.md)
- [pda-dynamic](../pda-dynamic/SKILL.md)
- [liquidity-migration](../liquidity-migration/SKILL.md)
- [fee-architecture](../fee-architecture/SKILL.md)
- [verification](../verification/SKILL.md)
