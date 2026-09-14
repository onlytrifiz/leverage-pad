# Block Explorers & Subgraphs

External tools for transaction analysis, event queries, and indexed data.

## When to Use Explorers

- View transaction details and traces
- Find contract creation and constructor args
- Query indexed event logs with filtering
- Verify contract source code
- Get historical pool data from subgraphs

---

## Etherscan

### Useful URLs

| Task | URL Pattern |
|------|-------------|
| Contract overview | `etherscan.io/address/<ADDR>` |
| Read functions | `etherscan.io/address/<ADDR>#readContract` |
| Write functions | `etherscan.io/address/<ADDR>#writeContract` |
| Events/Logs | `etherscan.io/address/<ADDR>#events` |
| Internal txs | `etherscan.io/address/<ADDR>#internaltx` |
| Token transfers | `etherscan.io/token/<TOKEN>#balances` |
| Transaction | `etherscan.io/tx/<TX_HASH>` |
| Contract creation | Find in tx list or via API |

### Network Explorers

| Network | Explorer |
|---------|----------|
| Mainnet | etherscan.io |
| Base | basescan.org |
| Arbitrum | arbiscan.io |
| Optimism | optimistic.etherscan.io |

### API Queries

```bash
# Set API key
export ETHERSCAN_KEY="your_api_key"

# Get contract ABI
curl "https://api.etherscan.io/api\
?module=contract\
&action=getabi\
&address=$CONTRACT\
&apikey=$ETHERSCAN_KEY"

# Get transaction list
curl "https://api.etherscan.io/api\
?module=account\
&action=txlist\
&address=$CONTRACT\
&startblock=0\
&endblock=99999999\
&sort=desc\
&apikey=$ETHERSCAN_KEY"

# Get event logs by topic
curl "https://api.etherscan.io/api\
?module=logs\
&action=getLogs\
&address=$CONTRACT\
&fromBlock=0\
&toBlock=latest\
&topic0=$EVENT_TOPIC\
&apikey=$ETHERSCAN_KEY"

# Get internal transactions
curl "https://api.etherscan.io/api\
?module=account\
&action=txlistinternal\
&address=$CONTRACT\
&apikey=$ETHERSCAN_KEY"
```

### Finding Contract Creation

1. Go to contract page on Etherscan
2. Look for "Contract Creator" in the overview
3. Click the creation transaction
4. "Input Data" contains constructor arguments

Or via API:
```bash
curl "https://api.etherscan.io/api\
?module=contract\
&action=getcontractcreation\
&contractaddresses=$CONTRACT\
&apikey=$ETHERSCAN_KEY"
```

---

## Uniswap Subgraphs

### Endpoints

| Network | V3 Subgraph |
|---------|-------------|
| Mainnet | `api.thegraph.com/subgraphs/name/uniswap/uniswap-v3` |
| Arbitrum | `api.thegraph.com/subgraphs/name/ianlapham/arbitrum-minimal` |
| Base | `api.studio.thegraph.com/query/48211/uniswap-v3-base/version/latest` |
| Optimism | `api.thegraph.com/subgraphs/name/ianlapham/optimism-post-regenesis` |

### Query Pool Data

```graphql
{
  pool(id: "0xPOOL_ADDRESS_LOWERCASE") {
    id
    token0 {
      symbol
      decimals
      id
    }
    token1 {
      symbol
      decimals
      id
    }
    sqrtPrice
    tick
    liquidity
    totalValueLockedToken0
    totalValueLockedToken1
    volumeToken0
    volumeToken1
    feeTier
    createdAtTimestamp
  }
}
```

### Query Swap History

```graphql
{
  swaps(
    where: { pool: "0xPOOL_ADDRESS_LOWERCASE" }
    orderBy: timestamp
    orderDirection: desc
    first: 100
  ) {
    id
    timestamp
    sender
    recipient
    amount0
    amount1
    sqrtPriceX96
    tick
    logIndex
    transaction {
      id
    }
  }
}
```

### Query Tick Data

```graphql
{
  ticks(
    where: { pool: "0xPOOL_ADDRESS_LOWERCASE" }
    orderBy: tickIdx
    first: 100
  ) {
    tickIdx
    liquidityGross
    liquidityNet
    price0
    price1
  }
}
```

### Query Position Data

```graphql
{
  positions(
    where: { pool: "0xPOOL_ADDRESS_LOWERCASE" }
    first: 100
  ) {
    id
    owner
    tickLower {
      tickIdx
    }
    tickUpper {
      tickIdx
    }
    liquidity
    depositedToken0
    depositedToken1
  }
}
```

### Execute Query

```bash
# Using curl
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ pool(id: \"0x...\") { sqrtPrice tick liquidity } }"}' \
  https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3
```

---

## Doppler Indexer

Doppler runs a GraphQL indexer (Ponder) for querying token and pool data.

### Endpoints

| Environment | URL | Supported Chains |
|-------------|-----|------------------|
| Production | `https://prod.indexer.doppler.lol/` | Base (8453), Unichain (130), Monad (143), Ink (57073) |
| Development | `https://test.indexer.doppler.lol/` | Base Sepolia (84532) |

### Check Indexer Health

Before trusting indexer data, verify the indexer status for your chain:

```graphql
query IndexerStatus {
  _meta {
    status
  }
}
```

```bash
# Check production indexer health
curl -s -X POST 'https://prod.indexer.doppler.lol/' \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ _meta { status } }"}' | jq

# Check testnet indexer health
curl -s -X POST 'https://test.indexer.doppler.lol/' \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ _meta { status } }"}' | jq
```

Example response:
```json
{
  "_meta": {
    "status": {
      "baseSepolia": {
        "id": 84532,
        "block": { "number": 36426528, "timestamp": 1768621344 }
      },
      "base": {
        "id": 8453,
        "block": { "number": 40915999, "timestamp": 1768621345 }
      }
      // ... other chains
    }
  }
}
```

**Important**: Use the production indexer for mainnet chains (Base, Unichain, Monad, Ink) and the testnet indexer for Base Sepolia development.

### Query Token Data

```graphql
query Token($address: String!, $chainId: Float!) {
  token(address: $address, chainId: $chainId) {
    address
    chainId
    name
    symbol
    decimals
    tokenUriData
    tokenUri
    totalSupply
    image
    isDerc20
    isCreatorCoin
    isContentCoin
    firstSeenAt
    lastSeenAt
    volumeUsd
    holderCount
    creatorAddress
    creatorCoinPid
    pool {
      address
      chainId
      tick
      sqrtPrice
      liquidity
      integrator
      createdAt
      price
      fee
      type
      dollarLiquidity
      dailyVolume
      volumeUsd
      percentDayChange
      totalFee0
      totalFee1
      graduationBalance
      graduationPercentage
      minThreshold
      maxThreshold
      isToken0
      lastRefreshed
      lastSwapTimestamp
      reserves0
      reserves1
      totalProceeds
      totalTokensSold
      holderCount
      marketCapUsd
      migrated
      migratedAt
      migratedToPool
      migratedToV4PoolId
      migratedFromPool
      migrationType
      isQuoteEth
      isQuoteZora
      isStreaming
      isContentCoin
      isCreatorCoin
      poolKey
      tickLower
      graduationTick
      quoteToken {
        address
      }
    }
  }
}
```

### Query Pool Data

```graphql
query Pool($address: String!, $chainId: Float!) {
  token(address: $address, chainId: $chainId) {
    pool {
      address
      chainId
      tick
      sqrtPrice
      liquidity
      integrator
      createdAt
      price
      fee
      type
      dollarLiquidity
      dailyVolume
      volumeUsd
      percentDayChange
      totalFee0
      totalFee1
      graduationBalance
      graduationPercentage
      minThreshold
      maxThreshold
      isToken0
      lastRefreshed
      lastSwapTimestamp
      reserves0
      reserves1
      totalProceeds
      totalTokensSold
      holderCount
      marketCapUsd
      migrated
      migratedAt
      migratedToPool
      migratedToV4PoolId
      migratedFromPool
      migrationType
      isQuoteEth
      isQuoteZora
      isStreaming
      isContentCoin
      isCreatorCoin
      poolKey
      tickLower
      graduationTick
      asset {
        address
      }
      baseToken {
        address
      }
      quoteToken {
        address
      }
    }
  }
}
```

### Execute Query

Populate token and pool addresses from SDK or deployment helpers. Do not copy hardcoded addresses into skill examples.

```bash
# Write query to file
cat > /tmp/query.json << 'EOF'
{
  "query": "query Token($address: String!, $chainId: Float!) { token(address: $address, chainId: $chainId) { address name symbol decimals totalSupply holderCount pool { address tick sqrtPrice price totalProceeds totalTokensSold migrated graduationPercentage } } }",
  "variables": {
    "address": "<TOKEN_ADDRESS_FROM_SDK>",
    "chainId": 84532
  }
}
EOF

# Query production indexer (mainnet chains)
curl -s -X POST 'https://prod.indexer.doppler.lol/' \
  -H 'Content-Type: application/json' \
  -d @/tmp/query.json | jq

# Query testnet indexer (Base Sepolia)
curl -s -X POST 'https://test.indexer.doppler.lol/' \
  -H 'Content-Type: application/json' \
  -d @/tmp/query.json | jq
```

### Chain IDs

| Network | Chain ID | Indexer |
|---------|----------|---------|
| Base | 8453 | Production |
| Unichain | 130 | Production |
| Monad | 143 | Production |
| Ink | 57073 | Production |
| Base Sepolia | 84532 | Development |

### Key Fields

| Field | Description |
|-------|-------------|
| `token.isDerc20` | Whether token is a Doppler ERC20 |
| `pool.type` | Pool type: `v3` or `v4` |
| `pool.totalProceeds` | Total numeraire received |
| `pool.totalTokensSold` | Total tokens sold |
| `pool.graduationPercentage` | Progress toward migration (0-100) |
| `pool.migrated` | Whether pool has migrated |
| `pool.minThreshold` / `maxThreshold` | Proceeds thresholds for migration |
| `pool.isToken0` | Token ordering in pool |

### Example Response

```json
{
  "data": {
    "token": {
      "address": "<TOKEN_ADDRESS_FROM_SDK>",
      "name": "<TOKEN_NAME>",
      "symbol": "<TOKEN_SYMBOL>",
      "decimals": 18,
      "totalSupply": "1000000000000000000000000000",
      "holderCount": 3,
      "pool": {
        "address": "<POOL_ADDRESS_FROM_SDK>",
        "tick": 155550,
        "sqrtPrice": "188988788814121998333541493509370",
        "price": "175746661556",
        "totalProceeds": "0",
        "totalTokensSold": "0",
        "migrated": false,
        "graduationPercentage": 0
      }
    }
  }
}
```

---

## DopplerLens Quoter

Doppler deploys a lens contract for off-chain queries. Resolve the lens address through SDK or deployment exports.

### Using DopplerLens

```bash
# Query current state without executing swap
cast call $DOPPLER_LENS "quoteDopplerLensData((address,bool,uint256,uint160,bytes))" \
  "($POOL_MANAGER,$ZERO_FOR_ONE,$AMOUNT,$SQRT_PRICE_LIMIT,$HOOK_DATA)"
```

Returns:
- `sqrtPriceX96` - Resulting price
- `amount0` - Token0 delta
- `amount1` - Token1 delta
- `tick` - Resulting tick

---

## Cross-Referencing Workflow

When verifying state, cross-check multiple sources:

```
1. On-chain (source of truth)
   └─► cast call / viem readContract

2. Block explorer
   └─► Etherscan read functions
   └─► Verify values match on-chain

3. Doppler Indexer (Ponder)
   └─► GraphQL query for token/pool data
   └─► Rich pre-computed fields (graduationPercentage, marketCapUsd)
   └─► May lag a few blocks

4. Uniswap Subgraph (indexed, may lag)
   └─► GraphQL query
   └─► Compare with on-chain
   └─► Note: Subgraph can be 1-2 blocks behind
```

### Handling Discrepancies

| Source | Trust Level | Notes |
|--------|-------------|-------|
| On-chain (latest) | Highest | Always authoritative |
| Archive node | High | Historical source of truth |
| Etherscan | High | May have slight delay |
| Doppler Indexer | Medium-High | Fast, has computed fields |
| Uniswap Subgraph | Medium | Can lag, indexer issues possible |
| Cached/API data | Lower | Always verify against chain |

---

## Debugging Failed Transactions

### On Etherscan

1. Find transaction: `etherscan.io/tx/<HASH>`
2. Check "Status" (Success/Fail)
3. Click "Click to see More"
4. View "State Changes" tab
5. Check "Internal Txns" for nested calls

### Using Tenderly

For detailed traces:
1. Go to `dashboard.tenderly.co`
2. Paste transaction hash
3. View execution trace
4. See storage changes
5. Identify revert reason

### Common Revert Reasons

| Error | Likely Cause |
|-------|--------------|
| `InsufficientLiquidity` | Not enough liquidity in range |
| `InvalidTick` | Tick not aligned to spacing |
| `Locked` | Pool is locked (reentrancy) |
| `NotAuthorized` | Caller lacks permission |
| `DeadlineExceeded` | Transaction too slow |

---

## Verifying Deployed Doppler Contracts

### Check Deployments

Reference addresses in `doppler/Deployments.md`:
- Airlock
- TokenFactory
- DopplerDeployer
- DopplerLensQuoter
- UniswapV3Initializer
- UniswapV4Initializer

### Verify Contract Source

1. Go to Etherscan contract page
2. Check "Contract" tab shows verified source
3. Compare bytecode if unverified:
   ```bash
   cast code $ADDRESS
   ```

---

## Tips

1. **Lowercase addresses** for subgraph queries (case-sensitive)
2. **Subgraphs can lag** 1-2 blocks - always verify critical data on-chain
3. **API rate limits** - cache responses when possible
4. **Event topics are case-sensitive** - use exact signature
5. **Use Tenderly** for complex transaction debugging
