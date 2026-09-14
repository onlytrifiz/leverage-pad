# Airlock Interface

This page documents the full Airlock integration surface used by Doppler skills, with `Airlock.sol` as source of truth.

## External/public interface

### Launch + lifecycle

```solidity
function create(/* CreateParams */) external /* returns (...) */;
function migrate(address asset) external /* returns (...) */;
```

Notes:
- `create(...)` is the protocol launch entrypoint.
- `migrate(asset)` executes initializer exit + migrator handoff once exit conditions are met.

[Source: Airlock.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/Airlock.sol) (lines 182, 194-226)

### Public state getters

```solidity
function getProtocolFees(address token) external view returns (uint256 amount);
function getIntegratorFees(address integrator, address token) external view returns (uint256 amount);
```

[Source: Airlock.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/Airlock.sol) (lines 121-122)

## Create params (integration-critical fields)

The create path uses a params struct (`CreateParams` / `createData`) that binds module selection and launch config.
Integration-critical fields referenced across skills include:

- `initialSupply`
- `numTokensToSell`
- `numeraire`
- `tokenFactory`
- `tokenFactoryData`
- `integrator`

[Source: Token lifecycle example + Airlock integrator assignment](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/Airlock.sol) (line 182), [Source: FACTORIES.md](../../token-lifecycle/references/FACTORIES.md)

## Completeness policy

- Treat `src/Airlock.sol` as canonical for full signature and return typing.
- When integrating, use the contract ABI generated from the exact deployed build.
- If a deployment uses a different commit, regenerate and diff interface before shipping.

## Full ABI extraction workflow

If you have the Doppler source checkout for the target deployment:

```bash
# Generate full ABI (authoritative interface)
forge inspect Airlock abi > airlock.abi.json

# Optional: inspect function signatures quickly
jq -r '.[] | select(.type=="function") | "\(.name)(\(.inputs | map(.type) | join(",")))"' airlock.abi.json
```

If you are integrating against an already-deployed instance, pull verified ABI from the relevant explorer and diff against your pinned source ABI before shipping.
