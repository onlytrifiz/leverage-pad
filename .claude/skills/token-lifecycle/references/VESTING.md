# Vesting Mechanics

Linear token vesting for pre-allocated recipients in Doppler tokens.

---

## VestingData Struct

```solidity
struct VestingData {
    uint256 totalAmount;      // Total tokens allocated to this address
    uint256 releasedAmount;   // Tokens already claimed
}
```

[Source: DERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/DERC20.sol) (lines 60-63), [Source: CloneERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/CloneERC20.sol) (lines 46-49)

---

## Vesting Formula

**Linear vesting** over `vestingDuration` seconds starting at `vestingStart`:

```solidity
if (block.timestamp < vestingStart + vestingDuration) {
    vestedAmount = totalAmount * (block.timestamp - vestingStart) / vestingDuration;
} else {
    vestedAmount = totalAmount;  // Fully vested
}

availableAmount = vestedAmount - releasedAmount;
```

[Source: DERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/DERC20.sol) (lines 264-273)

**Timeline**:
```
vestingStart                     vestingStart + vestingDuration
     |--------------------------------|
     0%        linear growth        100%
```

---

## Constraints

### DERC20 (Standard Token)

| Constraint | Value | Purpose |
|------------|-------|---------|
| `MAX_PRE_MINT_PER_ADDRESS_WAD` | `0.2 ether` (20%) | Cap per recipient |
| `MAX_TOTAL_PRE_MINT_WAD` | `0.2 ether` (20%) | Cap for all vesting |
| `MAX_YEARLY_MINT_RATE_WAD` | `0.02 ether` (2%) | Inflation cap |

[Source: DERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/DERC20.sol) (lines 44-50)

### CloneERC20 (Cloneable Token)

| Constraint | Value | Purpose |
|------------|-------|---------|
| `MAX_PRE_MINT_PER_ADDRESS_WAD` | `0.8 ether` (80%) | Cap per recipient |
| `MAX_TOTAL_PRE_MINT_WAD` | `0.8 ether` (80%) | Cap for all vesting |
| `MAX_YEARLY_MINT_RATE_WAD` | `0.02 ether` (2%) | Inflation cap |

[Source: CloneERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/CloneERC20.sol) (lines 33-39)

---

## Release Function

Claims all available vested tokens to the caller:

```solidity
function release() external hasVestingStarted {
    uint256 availableAmount = computeAvailableVestedAmount(msg.sender);
    getVestingDataOf[msg.sender].releasedAmount += availableAmount;
    _transfer(address(this), msg.sender, availableAmount);
}
```

[Source: DERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/DERC20.sol) (lines 253-257)

**Key points**:
- Reverts if `vestingStart == 0` (vesting not started)
- Claims entire available amount (no partial claims)
- Tokens held by contract until claimed

---

## Initialization

Vesting recipients are set at token deployment:

```solidity
constructor(
    ...
    uint256 vestingDuration_,
    address[] memory recipients_,  // Vesting recipients
    uint256[] memory amounts_,     // Amount per recipient
    ...
) {
    vestingStart = block.timestamp;
    vestingDuration = vestingDuration_;

    for (uint256 i; i < length; ++i) {
        getVestingDataOf[recipients_[i]].totalAmount += amounts_[i];
        // Validate per-address cap
        require(
            getVestingDataOf[recipients_[i]].totalAmount <= maxPreMintPerAddress,
            MaxPreMintPerAddressExceeded(...)
        );
        vestedTokens += amount;
    }

    // Validate total cap
    require(vestedTokens <= maxTotalPreMint, MaxTotalPreMintExceeded(...));

    // Mint vested tokens to contract (held until claimed)
    _mint(address(this), vestedTokens);

    // Mint remaining to recipient (typically Airlock)
    _mint(recipient, initialSupply - vestedTokens);
}
```

[Source: DERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/DERC20.sol) (lines 114-163)

---

## Inflation Minting

Inflation minting can begin after pool unlock according to token configuration and schedule.

[Source: DERC20.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/DERC20.sol) (lines 183-215)

**Activation**: Inflation starts when `unlockPool()` is called (after migration).

---

## Errors

| Error | Cause |
|-------|-------|
| `VestingNotStartedYet()` | Calling `release()` before vesting initialized |
| `MaxPreMintPerAddressExceeded(amount, limit)` | Recipient allocation exceeds cap |
| `MaxTotalPreMintExceeded(amount, limit)` | Total vesting exceeds cap |
| `MaxTotalVestedExceeded(amount, limit)` | Vested amount >= initial supply |
| `MaxYearlyMintRateExceeded(amount, limit)` | Mint rate > 2% |
| `MintingNotStartedYet()` | Calling `mintInflation()` before unlockPool() |

---

## Example: Calculate Vesting

```javascript
// Parameters
const vestingStart = 1700000000n;  // Unix timestamp
const vestingDuration = 31536000n; // 1 year in seconds
const totalAmount = 1000000n * 10n**18n; // 1M tokens

// Current time
const now = 1715000000n; // ~6 months later

// Calculate vested
const elapsed = now - vestingStart;
const vestedAmount = totalAmount * elapsed / vestingDuration;
// Result: ~476,190 tokens vested (47.6%)
```
