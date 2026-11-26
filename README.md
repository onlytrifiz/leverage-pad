# multiply.cash

Tokens whose trading fees run a leveraged position.

Every token launched on [multiply.cash](https://multiply.cash) is tied to a perpetual position on
[Lighter](https://lighter.xyz): a market (BTC, NVDA, gold…), a side, a leverage and a take-profit,
chosen at launch. Each trade of the token pays a fee. Most of it is deposited as margin and opens
the position in tranches, and when a tranche reaches its take-profit, its capital and most of its
gain buy the token on its own pool and burn it. The token can grow its buybacks even when nobody
new is buying.

The whole design is in the [whitepaper](web/public/whitepaper.pdf) and in the
[docs](https://multiply.cash/docs). News on [X](https://x.com/Multiply_cash).

## How the money moves

| Of every trading fee | Goes to |
|---|---|
| 5% | Doppler, the launch protocol |
| 25% | the protocol's treasury |
| 70% | the token's engine: margin on Lighter |

When a tranche takes profit, all of its capital and 70% of its gain buy and burn the token; 30% of
the gain goes to the protocol. Of everything the protocol earns, 70% buys and burns
[$MULTIPLY](https://multiply.cash/burn) every 30 minutes.

Liquidity is seeded one-sided into a Uniswap v4 pool by Doppler and locked: there is no owner, no
mint after launch, and the pool cannot be pulled.

## Repository

| Path | What it is |
|---|---|
| [`contracts-v4/`](contracts-v4/) | the launch router (UUPS) and the fee sink, in Solidity, with Foundry tests |
| [`keeper.js`](keeper.js), [`lib/`](lib/), [`lighter/`](lighter/) | the keeper: collects fees, runs every token's position on Lighter, takes profits, buys back and burns |
| [`web/`](web/) | the site, Next.js |
| [`test/`](test/) | the keeper's tests, run against a simulated venue and chain |
| [`docs/`](docs/) | whitepaper source and protocol notes |

The keeper runs on Railway with its state on a volume. It publishes a public snapshot, never
any key, at `/public.json`, which the site reads, and reports problems at `/alerts`.

## Addresses (Robinhood Chain, 4663)

| Contract | Address |
|---|---|
| $MULTIPLY | [`0xBe021bF099efF1C81d799079358943A981b77642`](https://robin.etherscan.io/token/0xBe021bF099efF1C81d799079358943A981b77642) |
| Launch router (proxy) | [`0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd`](https://robin.etherscan.io/address/0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd) |
| Doppler hook initializer | [`0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544`](https://robin.etherscan.io/address/0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544) |
| Doppler fee hook | [`0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215`](https://robin.etherscan.io/address/0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215) |

## Running it

```sh
npm install
npm test                 # the keeper's tests

cp .env.example .env     # then fill it in: RPC, keys, master secret
npm run keeper           # the keeper, against the chain and Lighter

cd web && npm install && npm run dev
cd contracts-v4 && forge test
```

The keeper signs Lighter orders through a small Python sidecar (`lighter/sidecar.py`), which needs
the `lighter-sdk` package in `lighter/.venv`.

## Risks

Positions use leverage and can be liquidated: the margin in them is lost, the pool and every
balance stay as they are. Tokens can go to zero. Nothing here is investment advice.

## License

MIT
