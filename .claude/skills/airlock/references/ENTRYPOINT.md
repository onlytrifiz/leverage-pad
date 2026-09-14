# Airlock as Protocol Entrypoint

`Airlock` is the launch lifecycle entrypoint and contract coordinator for Doppler.

## Responsibilities

1. Accept launch input through `create(...)`.
2. Orchestrate token deployment through the configured token factory.
3. Orchestrate sale initialization through the configured initializer.
4. Execute post-sale migration through the configured liquidity migrator.

## Downstream contract boundaries

| Module class | Airlock interaction |
|---|---|
| Token factories | Called during `create(...)` |
| Initializers | Called during `create(...)` and `migrate(...)` lifecycle |
| Liquidity migrators | Called during `migrate(asset)` |
| Top-up / split modules | Preconfigured module + migrator-time calls |
[Source: Airlock.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/Airlock.sol) (lines 194-226, 237-252)
