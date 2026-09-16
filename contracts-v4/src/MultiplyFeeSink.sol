// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IBurnable {
    function burn(uint256 value) external;
}

/// The views the sink reads live from the router: rotating the keeper key or moving the
/// treasury to a multisig must not require touching every coin's sink.
interface ISinkRouter {
    function keeper() external view returns (address);
    function treasury() external view returns (address);
    function owner() external view returns (address);
}

/**
 * @title MultiplyFeeSink
 * @notice One per coin, cloned (EIP-1167) by the MultiplyLaunchRouter inside `launch()` and
 * handed to Doppler's Rehype hook as `buybackDst` and to the pool as its 95% beneficiary. The
 * hook fixes `buybackDst` at initialization and has no setter, so this is the address every
 * fee of the coin will ever reach: a contract, not the operator's key.
 *
 * What lands here: the trading fee in numeraire (buys pay it in the coin and the hook swaps it
 * into numeraire in the same call; sells pay it in numeraire) and, only when that internal swap
 * cannot execute, the coin itself via the hook's public `collectFees`.
 *
 * What leaves, and how: `flush()` is public. It sends `treasuryBps / receivedBps` of the
 * numeraire held to the protocol treasury and the rest to `destination`, the coin's sub-wallet
 * that funds its perp, and burns any coin held (DopplerERC20V1 has a real `burn`). The split is
 * fixed at launch; the treasury and keeper addresses are read live from the router.
 *
 * `destination` is set by the keeper the first time, after it derives the coin's sub-wallet: that
 * is automation, one transaction per coin. Any later change is the router OWNER's alone (a
 * multisig at go-live): the way to recover a sub-wallet that turned out wrong or unusable, held
 * by the key that already governs every future launch, and out of reach of the keeper key that
 * signs every day. There is deliberately NO function that calls the hook's
 * `setFeeDistribution`: the sink is the only address allowed to, and without the call the fee
 * matrix set at launch is immutable.
 */
contract MultiplyFeeSink is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;

    /// @notice The router that clones and initializes sinks. Immutable: lives in the
    /// implementation's bytecode, which every clone delegates to.
    address public immutable ROUTER;

    address public asset;
    address public numeraire;
    /// @notice Protocol share of the trading fee, in bps of the whole fee (1500 = 15%).
    uint16 public treasuryBps;
    /// @notice Share of the trading fee that actually reaches this sink (the hook keeps Doppler's
    /// slice before anything is sent), in bps of the whole fee (9500 = 95%).
    uint16 public receivedBps;
    /// @notice The coin's sub-wallet: where the engine's share goes. Set once, never changed.
    address public destination;

    event Initialized(address indexed asset, address indexed numeraire, uint16 treasuryBps, uint16 receivedBps);
    event DestinationSet(address indexed destination, address indexed by);
    event Flushed(uint256 toTreasury, uint256 toDestination, uint256 burned);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error NotRouter();
    error NotKeeper();
    error NotOwner();
    error AlreadyInitialized();
    error ZeroAddress();
    error DestinationNotSet();
    error InvalidShares();
    error CannotSweep(address token);

    constructor(address router) {
        if (router == address(0)) revert ZeroAddress();
        ROUTER = router;
    }

    modifier onlyKeeper() {
        if (msg.sender != ISinkRouter(ROUTER).keeper()) revert NotKeeper();
        _;
    }

    /// @notice Called by the router right after the Airlock returns the token address.
    function initialize(address asset_, address numeraire_, uint16 treasuryBps_, uint16 receivedBps_) external {
        if (msg.sender != ROUTER) revert NotRouter();
        if (asset != address(0)) revert AlreadyInitialized();
        if (asset_ == address(0) || numeraire_ == address(0)) revert ZeroAddress();
        if (receivedBps_ == 0 || receivedBps_ > BPS || treasuryBps_ > receivedBps_) revert InvalidShares();
        asset = asset_;
        numeraire = numeraire_;
        treasuryBps = treasuryBps_;
        receivedBps = receivedBps_;
        emit Initialized(asset_, numeraire_, treasuryBps_, receivedBps_);
    }

    /// @notice First call: the keeper points the sink at the coin's sub-wallet. Later calls:
    /// the router owner only, to move it when the sub-wallet cannot be used any more.
    function setDestination(address destination_) external {
        if (destination_ == address(0)) revert ZeroAddress();
        if (destination == address(0)) {
            if (msg.sender != ISinkRouter(ROUTER).keeper()) revert NotKeeper();
        } else if (msg.sender != ISinkRouter(ROUTER).owner()) {
            revert NotOwner();
        }
        destination = destination_;
        emit DestinationSet(destination_, msg.sender);
    }

    /**
     * @notice Moves everything held: numeraire split between treasury and destination, coin
     * burned. Anyone can call it; nothing here depends on who does.
     *
     * The three legs are independent. A transfer that fails (a frozen or otherwise unusable
     * recipient) leaves ITS share in the sink for a later flush and does not block the others:
     * the treasury's share never depends on the destination being usable, and vice versa. The
     * event reports what actually moved.
     */
    function flush() external nonReentrant returns (uint256 toTreasury, uint256 toDestination, uint256 burned) {
        address dst = destination;
        if (dst == address(0)) revert DestinationNotSet();

        uint256 held = IERC20(numeraire).balanceOf(address(this));
        if (held > 0) {
            uint256 treasuryShare = held * treasuryBps / receivedBps;
            uint256 destinationShare = held - treasuryShare;
            if (treasuryShare > 0) {
                address treasury = ISinkRouter(ROUTER).treasury();
                if (treasury != address(0) && _tryTransfer(numeraire, treasury, treasuryShare)) toTreasury = treasuryShare;
            }
            if (_tryTransfer(numeraire, dst, destinationShare)) toDestination = destinationShare;
        }

        uint256 coinHeld = IERC20(asset).balanceOf(address(this));
        if (coinHeld > 0) {
            // same rule as the transfers: a burn that fails waits, it does not undo the USDG legs
            try IBurnable(asset).burn(coinHeld) {
                burned = coinHeld;
            } catch {}
        }

        emit Flushed(toTreasury, toDestination, burned);
    }

    /// @dev ERC20 transfer that reports failure instead of reverting: a revert or a `false` return
    /// leaves the amount in the sink. Same acceptance rule as SafeERC20 (no return data counts as ok).
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    /// @notice Recovers a token sent here by mistake. Never the numeraire or the coin: those
    /// only ever leave through `flush()`.
    function sweep(address token, address to) external onlyKeeper nonReentrant returns (uint256 amount) {
        if (token == numeraire || token == asset) revert CannotSweep(token);
        if (to == address(0)) revert ZeroAddress();
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    /// @notice What a `flush()` would move right now.
    function pending() external view returns (uint256 numeraireHeld, uint256 assetHeld) {
        numeraireHeld = IERC20(numeraire).balanceOf(address(this));
        assetHeld = IERC20(asset).balanceOf(address(this));
    }
}
