# Fee Collection

Mechanisms for collecting and distributing fees to beneficiaries in locked pools.

---

## FeesManager Base Contract

Abstract contract implementing MasterChef-style fee distribution.

### Fee Formula

```
            (cumulatedFees - lastCumulatedFees) × shares
    fees = ─────────────────────────────────────────────────
                                WAD
```

[Source: FeesManager.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/base/FeesManager.sol) (lines 48-52)

### State Variables

```solidity
// Total fees accumulated for pool (token0)
mapping(PoolId poolId => uint256) public getCumulatedFees0;

// Total fees accumulated for pool (token1)
mapping(PoolId poolId => uint256) public getCumulatedFees1;

// Last collection checkpoint for beneficiary (token0)
mapping(PoolId => mapping(address => uint256)) public getLastCumulatedFees0;

// Last collection checkpoint for beneficiary (token1)
mapping(PoolId => mapping(address => uint256)) public getLastCumulatedFees1;

// Beneficiary share allocation (WAD-scaled)
mapping(PoolId => mapping(address => uint256)) public getShares;
```

[Source: FeesManager.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/base/FeesManager.sol) (lines 57-69)

---

## Collection Flow

### 1. collectFees()

```solidity
function collectFees(PoolId poolId) external nonReentrant returns (uint128 fees0, uint128 fees1) {
    // 1. Call virtual _collectFees (implemented by subclass)
    BalanceDelta fees = _collectFees(poolId);

    // 2. Update cumulated totals
    getCumulatedFees0[poolId] += fees.amount0();
    getCumulatedFees1[poolId] += fees.amount1();

    // 3. Release fees to caller if they're a beneficiary
    _releaseFees(poolId, msg.sender);
}
```

[Source: FeesManager.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/base/FeesManager.sol) (lines 80-91)

### 2. _releaseFees()

```solidity
function _releaseFees(PoolId poolId, address beneficiary) internal {
    uint256 shares = getShares[poolId][beneficiary];

    if (shares > 0) {
        // Calculate delta since last collection
        uint256 delta0 = getCumulatedFees0[poolId] - getLastCumulatedFees0[poolId][beneficiary];
        uint256 amount0 = delta0 * shares / WAD;

        // Update checkpoint
        getLastCumulatedFees0[poolId][beneficiary] = getCumulatedFees0[poolId];

        // Transfer fees
        if (amount0 > 0) poolKey.currency0.transfer(beneficiary, amount0);

        // Repeat for token1...
    }
}
```

[Source: FeesManager.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/base/FeesManager.sol) (lines 141-158)

---

## Beneficiary Management

### Storing Beneficiaries

```solidity
function _storeBeneficiaries(
    PoolKey memory poolKey,
    BeneficiaryData[] memory beneficiaries,
    address protocolOwner,
    uint96 protocolOwnerShares
) internal
```

[Source: FeesManager.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/base/FeesManager.sol) (lines 125-134)

**Requirements** (from BeneficiaryData.sol):
1. Addresses sorted ascending
2. Each share > 0
3. Total shares == WAD (1e18)
4. Protocol owner included with >= 5% share

### Updating Beneficiary

```solidity
function updateBeneficiary(PoolId poolId, address newBeneficiary) external {
    // 1. Release pending fees to both parties
    _releaseFees(poolId, msg.sender);
    _releaseFees(poolId, newBeneficiary);

    // 2. Transfer shares
    getShares[poolId][newBeneficiary] += getShares[poolId][msg.sender];
    getShares[poolId][msg.sender] = 0;
}
```

[Source: FeesManager.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/base/FeesManager.sol) (lines 99-116)

---

## StreamableFeesLocker (V1)

Position-based fee streaming for Uniswap V4 NFT positions.

### Architecture
- Receives positions via `onERC721Received()`
- Position locked for `lockDuration` seconds
- Fees distributed to beneficiaries pro-rata

### Key Functions

```solidity
// Collect and distribute fees
function distributeFees(uint256 tokenId) external;

// Claim accumulated fees
function releaseFees(uint256 tokenId) external;
```

[Source: StreamableFeesLocker.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/StreamableFeesLocker.sol) (lines 161, 226)

### Position Data

```solidity
struct PositionData {
    address recipient;           // NFT receiver after unlock
    uint32 startDate;            // Lock start timestamp
    uint32 lockDuration;         // Lock duration in seconds
    bool isUnlocked;             // Unlock status
    BeneficiaryData[] beneficiaries;
}
```

[Source: StreamableFeesLocker.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/StreamableFeesLocker.sol) (lines 19-25)

---

## StreamableFeesLockerV2

Pool-based fee streaming using FeesManager.

### Architecture
- Extends `FeesManager` for beneficiary tracking
- Manages positions directly via `MiniV4Manager`
- Virtual fee accumulation (no per-position tracking)

### Key Functions

```solidity
// Lock positions and set beneficiaries
function lock(
    PoolKey memory poolKey,
    uint32 lockDuration,
    address recipient,
    BeneficiaryData[] calldata beneficiaries,
    Position[] calldata positions
) external onlyApprovedMigrator;
```

[Source: StreamableFeesLockerV2.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/StreamableFeesLockerV2.sol) (lines 101-126)

### Stream Data

```solidity
struct StreamData {
    PoolKey poolKey;
    address recipient;
    uint32 startDate;
    uint32 lockDuration;
    bool isUnlocked;
    BeneficiaryData[] beneficiaries;
    Position[] positions;
}
```

[Source: StreamableFeesLockerV2.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/StreamableFeesLockerV2.sol) (lines 27-35)

---

## Comparison

| Feature | V1 (StreamableFeesLocker) | V2 (StreamableFeesLockerV2) |
|---------|---------------------------|----------------------------|
| Position type | NFT-based | Direct liquidity |
| Fee tracking | Per-position | Per-pool (FeesManager) |
| Gas efficiency | Lower | Higher |
| Beneficiary update | Per-position | Per-pool |

---

## Permanent Lock (No-Op Governance)

Set `recipient = DEAD_ADDRESS (0xdead)` for permanent lock:

```solidity
// Position permanently locked, beneficiaries collect fees forever
if (recipient != DEAD_ADDRESS) {
    // Normal unlock after lockDuration
} else {
    // Never unlocks, fees stream indefinitely
}
```

[Source: StreamableFeesLocker.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/StreamableFeesLocker.sol) (lines 144-146)
