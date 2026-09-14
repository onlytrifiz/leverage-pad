# Token Factories

Deployment patterns for Doppler tokens via factory contracts.

---

## Factory Types

| Factory | Token Type | Deployment | Gas Cost |
|---------|------------|------------|----------|
| `TokenFactory` | DERC20 | CREATE2 | Higher |
| `CloneERC20Factory` | CloneERC20 | ERC1167 proxy | Lower |

---

## TokenFactory

Deploys full DERC20 tokens using CREATE2 for deterministic addresses.

```solidity
function create(
    uint256 initialSupply,
    address recipient,      // Receives non-vested tokens (Airlock)
    address owner,          // Token owner (governance)
    bytes32 salt,           // Deterministic deployment salt
    bytes calldata data     // Encoded token parameters
) external returns (address)
```

[Source: TokenFactory.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/TokenFactory.sol) (lines 20-51)

### Token Data Encoding

```solidity
bytes memory tokenData = abi.encode(
    string name,
    string symbol,
    uint256 yearlyMintRate,    // WAD-scaled (0.02e18 = 2%)
    uint256 vestingDuration,   // Seconds
    address[] recipients,      // Vesting recipients
    uint256[] amounts,         // Amounts per recipient
    string tokenURI            // Metadata URI
);
```

### Features
- Full DERC20 bytecode deployed
- Includes ERC20Votes and ERC20Permit
- Max 20% vesting cap
- Higher gas cost but full feature set

---

## CloneERC20Factory

Deploys minimal proxy clones pointing to a shared implementation.

```solidity
function create(
    uint256 initialSupply,
    address recipient,
    address owner,
    bytes32 salt,
    bytes calldata tokenData
) external returns (address asset)
```

[Source: CloneERC20Factory.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/CloneERC20Factory.sol) (lines 44-75)

### How It Works

1. Factory deploys implementation contract in constructor
2. `create()` clones the implementation via ERC1167
3. Clone is initialized with provided parameters

```solidity
constructor(address airlock_) ImmutableAirlock(airlock_) {
    IMPLEMENTATION = address(new CloneERC20());
    // Initialize implementation to prevent re-initialization attacks
    CloneERC20(IMPLEMENTATION).initialize(...);
}

function create(...) {
    asset = LibClone.cloneDeterministic(IMPLEMENTATION, salt);
    CloneERC20(asset).initialize(...);
}
```

[Source: CloneERC20Factory.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/CloneERC20Factory.sol) (lines 20-24, 61-74)

### Features
- Minimal proxy (ERC1167) pattern
- Significantly lower deployment gas
- Max 80% vesting cap
- No voting rights
- Uses Solady libraries

---

## Token Data Parameters

Both factories accept the same encoded parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Token name (e.g., "My Token") |
| `symbol` | `string` | Token symbol (e.g., "MTK") |
| `yearlyMintRate` | `uint256` | Inflation rate in WAD (max 0.02e18) |
| `vestingDuration` | `uint256` | Vesting period in seconds |
| `recipients` | `address[]` | Addresses receiving vested tokens |
| `amounts` | `uint256[]` | Token amounts per recipient |
| `tokenURI` | `string` | Metadata URI for the token |

---

## Choosing a Factory

| Use Case | Recommended Factory |
|----------|---------------------|
| DAO with governance voting | TokenFactory (DERC20) |
| Gas-sensitive deployment | CloneERC20Factory |
| Need ERC20Permit | TokenFactory (DERC20) |
| High vesting allocation (>20%) | CloneERC20Factory |
| Standard token launch | Either works |

---

## Deployment Example

```solidity
// Via Airlock.create()
Airlock.create(
    CreateParams({
        initialSupply: 1_000_000 ether,
        numTokensToSell: 500_000 ether,
        numeraire: WETH,
        tokenFactory: address(cloneERC20Factory),
        tokenFactoryData: abi.encode(
            "My Token",           // name
            "MTK",                // symbol
            0.02 ether,           // 2% yearly mint rate
            365 days,             // 1 year vesting
            [founder, advisor],   // recipients
            [100_000 ether, 50_000 ether], // amounts
            "ipfs://..."          // tokenURI
        ),
        ...
    })
);
```

---

## Variants

### TokenFactory80 / DERC2080

Alternative factory with 80% vesting cap (like CloneERC20 but with voting):

| Constant | DERC20 | DERC2080 |
|----------|--------|----------|
| Max per address | 20% | 80% |
| Max total | 20% | 80% |

[Source: DERC2080.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/DERC2080.sol), [Source: TokenFactory80.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/TokenFactory80.sol)

### CloneERC20Votes / CloneERC20VotesFactory

Cloneable tokens WITH voting rights:

```solidity
contract CloneERC20Votes is ERC20, ERC20Votes, Initializable, Ownable
```

[Source: CloneERC20Votes.sol](https://raw.githubusercontent.com/whetstoneresearch/doppler/46bad16d/src/tokens/CloneERC20Votes.sol)
