# Direct RPC Calls

Raw JSON-RPC calls for archive node queries, custom tooling, and debugging raw responses.

## When to Use RPC

- Historical state queries (requires archive node)
- Custom tooling without Foundry/Node dependencies
- Debugging raw hex responses
- Transaction simulation
- Low-level protocol interactions

---

## Essential Methods

### eth_call - Read Contract State

```bash
# Generic pattern
curl -X POST $ETH_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [{
      "to": "0xCONTRACT_ADDRESS",
      "data": "0xSELECTOR_AND_ARGS"
    }, "latest"],
    "id": 1
  }'
```

### eth_getStorageAt - Direct Slot Read

```bash
curl -X POST $ETH_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getStorageAt",
    "params": [
      "0xCONTRACT_ADDRESS",
      "0x0",
      "latest"
    ],
    "id": 1
  }'
```

### eth_getLogs - Query Events

```bash
curl -X POST $ETH_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getLogs",
    "params": [{
      "address": "0xCONTRACT_ADDRESS",
      "topics": ["0xEVENT_SIGNATURE_HASH"],
      "fromBlock": "0x11A0000",
      "toBlock": "latest"
    }],
    "id": 1
  }'
```

### eth_getTransactionReceipt - Get Logs from Tx

```bash
curl -X POST $ETH_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getTransactionReceipt",
    "params": ["0xTRANSACTION_HASH"],
    "id": 1
  }'
```

---

## Historical State Queries

**Requires archive node** (Alchemy, QuickNode archive, or self-hosted)

### State at Specific Block

```bash
# Convert block number to hex: 18500000 = 0x11A6680
BLOCK_HEX="0x11A6680"

curl -X POST $ARCHIVE_RPC_URL \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"eth_call\",
    \"params\": [{
      \"to\": \"$CONTRACT\",
      \"data\": \"$CALLDATA\"
    }, \"$BLOCK_HEX\"],
    \"id\": 1
  }"
```

### Block Number Conversion

```bash
# Decimal to hex
printf "0x%x\n" 18500000  # 0x11a6680

# Or use cast
cast --to-hex 18500000
```

---

## Computing Selectors and Calldata

### Function Selectors

```bash
# Using cast
cast sig "slot0()"
# Returns: 0x3850c7bd

cast sig "state()"
# Returns selector for Doppler state()

cast sig "getState(address)"
# Returns selector for V3 initializer
```

### Encode Arguments

```bash
# Encode function call with arguments
cast calldata "getState(address)" 0x1234...

# Or separately:
SELECTOR=$(cast sig "getState(address)")
ARGS=$(cast abi-encode "getState(address)" 0x1234... | cut -c3-)
echo "${SELECTOR}${ARGS}"
```

### Common Doppler Selectors

| Function | Selector |
|----------|----------|
| `slot0()` | `0x3850c7bd` |
| `state()` | Compute with `cast sig` |
| `isToken0()` | Compute with `cast sig` |
| `getCurrentEpoch()` | Compute with `cast sig` |
| `positions(bytes32)` | Compute with `cast sig` |

---

## Decoding Responses

### Hex to Decimal

```bash
# Simple value
cast --to-dec 0x1e  # 30

# Large value
cast --to-dec 0x00000000000000000000000000000000000000000000000000000000000f4240
# 1000000
```

### Signed Integers

```bash
# Decode as int256
cast --to-int256 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
# -1
```

### Complex Return Types

```bash
# Decode tuple response
cast abi-decode "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" 0x...

# Decode state() response
cast abi-decode "state()(uint40,int256,uint256,uint256,uint256,int128,int128)" 0x...
```

---

## Doppler Event Topics

Compute with `cast sig-event`:

```bash
# Rebalance(int24 currentTick, int24 tickLower, int24 tickUpper, uint256 epoch)
cast sig-event "Rebalance(int24,int24,int24,uint256)"

# Swap(int24 currentTick, uint256 totalProceeds, uint256 totalTokensSold)
cast sig-event "Swap(int24,uint256,uint256)"

# EarlyExit(uint256 epoch)
cast sig-event "EarlyExit(uint256)"

# InsufficientProceeds()
cast sig-event "InsufficientProceeds()"
```

### Query Rebalance Events

```bash
REBALANCE_TOPIC=$(cast sig-event "Rebalance(int24,int24,int24,uint256)")

curl -X POST $ETH_RPC_URL \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"eth_getLogs\",
    \"params\": [{
      \"address\": \"$HOOK_ADDRESS\",
      \"topics\": [\"$REBALANCE_TOPIC\"],
      \"fromBlock\": \"0x0\",
      \"toBlock\": \"latest\"
    }],
    \"id\": 1
  }"
```

---

## Examples

### Read Doppler State at Historical Block

```bash
# 1. Get selector
STATE_SELECTOR=$(cast sig "state()")

# 2. Query at block 18500000
BLOCK_HEX=$(cast --to-hex 18500000)

curl -X POST $ARCHIVE_RPC_URL \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"eth_call\",
    \"params\": [{
      \"to\": \"$HOOK_ADDRESS\",
      \"data\": \"$STATE_SELECTOR\"
    }, \"$BLOCK_HEX\"],
    \"id\": 1
  }" | jq -r '.result'

# 3. Decode result
cast abi-decode "state()(uint40,int256,uint256,uint256,uint256,int128,int128)" $RESULT
```

### Get State Before and After a Transaction

```bash
# Get tx block number
BLOCK=$(cast tx $TX_HASH --field blockNumber)

# State before (block - 1)
BEFORE_BLOCK=$(cast --to-hex $((BLOCK - 1)))
# Query state at BEFORE_BLOCK

# State after (block)
AFTER_BLOCK=$(cast --to-hex $BLOCK)
# Query state at AFTER_BLOCK
```

### Find All Swaps in Block Range

```bash
SWAP_TOPIC=$(cast sig-event "Swap(int24,uint256,uint256)")
FROM_BLOCK=$(cast --to-hex 18500000)
TO_BLOCK=$(cast --to-hex 18510000)

curl -X POST $ETH_RPC_URL \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"eth_getLogs\",
    \"params\": [{
      \"address\": \"$HOOK_ADDRESS\",
      \"topics\": [\"$SWAP_TOPIC\"],
      \"fromBlock\": \"$FROM_BLOCK\",
      \"toBlock\": \"$TO_BLOCK\"
    }],
    \"id\": 1
  }" | jq '.result'
```

---

## Archive Node Providers

| Provider | Archive Support | Notes |
|----------|----------------|-------|
| Alchemy | Yes (Growth+) | Most reliable |
| QuickNode | Yes (add-on) | Fast |
| Infura | Limited | Archive add-on |
| Ankr | Yes | Public endpoints available |
| Local (Erigon) | Yes | Full control |

---

## Tips

1. **Always convert block numbers to hex** for RPC params
2. **Use `jq`** to parse JSON responses: `| jq '.result'`
3. **Archive nodes required** for historical queries (non-latest block)
4. **Rate limits apply** - batch requests when possible
5. **Check provider docs** for supported methods and limits
