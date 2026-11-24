// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAirlock, IBundler, DopplerTypes} from "./interfaces/IDoppler.sol";
import {MultiplyLaunchRouter} from "./MultiplyLaunchRouter.sol";

/**
 * @title DopplerLaunch
 * @notice The Doppler side of a launch: the Airlock parameters every coin shares, and the create
 * call with its optional launch buy. External library of `MultiplyLaunchRouter`: it runs by
 * delegatecall (`address(this)` is the router, `msg.sender` the launcher) and only exists to keep
 * the router under the contract size limit. It has no storage and validates nothing: the router
 * has already checked the input against its policy.
 *
 * The launch buy is one swap, through Doppler's Bundler in the call frame that creates the market:
 * the hook exempts a single swap from the non-protocol part of the opening fee. The launcher pays
 * for all of it; `orders` only says which wallets get which part of the tokens, pro rata to their
 * amounts, so every wallet gets the same average price.
 */
library DopplerLaunch {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;

    uint256 private constant MAX_ORDERS = 32;

    /// @dev What the router computed for this launch.
    struct Opening {
        address hub; // where every fee of the coin lands
        int24 tick;
        int24 maxTick;
    }

    /// @notice One wallet's part of a launch buy. Declared here and emitted by the router.
    event LaunchBuy(address indexed asset, address indexed wallet, uint256 amountIn, uint256 amountOut);

    error TooManyOrders(uint256 count);
    error InvalidOrder(uint256 index);
    error TooFewTokens(uint256 totalOut, uint256 minOut);

    /// @dev Creates the market and runs the launch buy, if any. Returns the token and the whole
    /// buy: numeraire in, tokens out.
    function execute(
        MultiplyLaunchRouter.LaunchInput calldata input,
        MultiplyLaunchRouter.BuyOrder[] calldata orders,
        MultiplyLaunchRouter.Policy memory p,
        MultiplyLaunchRouter.Modules memory m,
        Opening memory o
    ) external returns (address asset, uint128 totalIn, uint128 totalOut) {
        IAirlock.CreateParams memory params = _buildCreateParams(input, p, m, o.hub, o.tick, o.maxTick);
        if (input.firstBuy == 0 && orders.length == 0) {
            (asset,,,,) = IAirlock(m.airlock).create(params);
            return (asset, 0, 0);
        }

        totalIn = _totalIn(input.firstBuy, orders);
        IERC20(p.numeraire).safeTransferFrom(msg.sender, address(this), totalIn);
        IERC20(p.numeraire).forceApprove(m.bundler, totalIn);
        (asset,,,, totalOut) = IBundler(m.bundler).bundle(
            params,
            IBundler.VestingParams({permissionlessClaim: false, vestingDuration: 0, cliffDuration: 0}),
            totalIn,
            orders.length == 0 ? msg.sender : address(this)
        );
        IERC20(p.numeraire).forceApprove(m.bundler, 0);
        if (totalOut < input.minOut) revert TooFewTokens(totalOut, input.minOut);
        if (orders.length != 0) _distribute(asset, totalIn, totalOut, input.firstBuy, orders);
    }

    /// @dev Validates the orders and sums the whole buy.
    function _totalIn(uint128 firstBuy, MultiplyLaunchRouter.BuyOrder[] calldata orders)
        private
        view
        returns (uint128 total)
    {
        if (orders.length > MAX_ORDERS) revert TooManyOrders(orders.length);
        total = firstBuy;
        for (uint256 i; i < orders.length; i++) {
            address w = orders[i].wallet;
            if (w == address(0) || w == address(this) || orders[i].amount == 0) revert InvalidOrder(i);
            total += orders[i].amount; // checked uint128
        }
    }

    /// @dev Hands out `totalOut` pro rata. Rounding dust (under one raw unit per order) goes to the
    /// launcher, or to the last wallet when the launcher did not buy.
    function _distribute(
        address asset,
        uint256 totalIn,
        uint256 totalOut,
        uint128 launcherBuy,
        MultiplyLaunchRouter.BuyOrder[] calldata orders
    ) private {
        uint256 left = totalOut;
        for (uint256 i; i < orders.length; i++) {
            // uint128 * uint128: cannot overflow
            uint256 out = launcherBuy == 0 && i == orders.length - 1 ? left : totalOut * orders[i].amount / totalIn;
            left -= out;
            IERC20(asset).safeTransfer(orders[i].wallet, out);
            emit LaunchBuy(asset, orders[i].wallet, orders[i].amount, out);
        }
        if (left > 0) {
            IERC20(asset).safeTransfer(msg.sender, left);
            emit LaunchBuy(asset, msg.sender, launcherBuy, left);
        }
    }

    /// @dev `hub` is where every fee of this coin lands: its sink, or the policy fee hub when
    /// sinks are disabled. It is the hook's `buybackDst`, the pool's 95% beneficiary and the
    /// Airlock integrator, so nothing about the coin's fees ever points anywhere else.
    function _buildCreateParams(
        MultiplyLaunchRouter.LaunchInput calldata input,
        MultiplyLaunchRouter.Policy memory p,
        MultiplyLaunchRouter.Modules memory m,
        address hub,
        int24 tick,
        int24 maxTick
    ) internal view returns (IAirlock.CreateParams memory params) {
        bytes memory tokenFactoryData = abi.encode(
            input.name,
            input.symbol,
            new DopplerTypes.VestingSchedule[](0),
            new address[](0),
            new uint256[](0),
            new uint256[](0),
            input.tokenURI,
            uint256(0),
            uint48(0),
            address(0),
            new address[](0)
        );

        // The hook is always attached: it is what turns every fee into numeraire. Protection only
        // shapes the schedule; without it the fee is flat from the first block.
        DopplerTypes.RehypeInitData memory r;
        r.numeraire = p.numeraire;
        r.buybackDst = hub;
        r.startFee = input.snipeSeconds == 0 ? input.fee : input.snipeStartFee;
        r.endFee = input.fee;
        r.durationSeconds = input.snipeSeconds;
        // coin-side fees (from buys) are swapped into numeraire; numeraire-side fees pass straight through
        r.feeDistributionInfo.assetFeesToNumeraireBuybackWad = WAD;
        r.feeDistributionInfo.numeraireFeesToNumeraireBuybackWad = WAD;
        bytes memory onInit = abi.encode(r);

        DopplerTypes.BeneficiaryData[] memory bens = _beneficiaries(IAirlock(m.airlock).owner(), hub, p.protocolShareWad);
        DopplerTypes.Curve[] memory curves = new DopplerTypes.Curve[](1);
        curves[0] = DopplerTypes.Curve({tickLower: tick, tickUpper: maxTick, numPositions: 1, shares: WAD});

        DopplerTypes.InitializerData memory init = DopplerTypes.InitializerData({
            fee: 0, // no LP fee: the hook takes the trading fee so it can land in numeraire
            tickSpacing: p.tickSpacing,
            farTick: maxTick - p.tickSpacing, // must sit strictly below the top of the ladder
            curves: curves,
            beneficiaries: bens,
            dopplerHook: m.rehype,
            onInitializationDopplerHookCalldata: onInit,
            graduationDopplerHookCalldata: ""
        });

        params = IAirlock.CreateParams({
            initialSupply: p.supply,
            numTokensToSell: p.supply,
            numeraire: p.numeraire,
            tokenFactory: m.tokenFactory,
            tokenFactoryData: tokenFactoryData,
            governanceFactory: m.governanceFactory,
            governanceFactoryData: "",
            poolInitializer: m.poolInitializer,
            poolInitializerData: abi.encode(init),
            liquidityMigrator: m.liquidityMigrator,
            liquidityMigratorData: "",
            integrator: hub,
            salt: keccak256(abi.encodePacked(msg.sender, input.salt))
        });
    }

    /// @dev Doppler requires beneficiaries sorted by address and summing to WAD, protocol owner included.
    function _beneficiaries(address protocolOwner, address hub, uint256 protocolShareWad)
        internal
        pure
        returns (DopplerTypes.BeneficiaryData[] memory bens)
    {
        if (protocolOwner == hub) revert MultiplyLaunchRouter.FeeHubIsProtocolOwner(hub);
        bens = new DopplerTypes.BeneficiaryData[](2);
        DopplerTypes.BeneficiaryData memory proto =
            DopplerTypes.BeneficiaryData({beneficiary: protocolOwner, shares: uint96(protocolShareWad)});
        DopplerTypes.BeneficiaryData memory ours =
            DopplerTypes.BeneficiaryData({beneficiary: hub, shares: uint96(WAD - protocolShareWad)});
        if (protocolOwner < hub) {
            bens[0] = proto;
            bens[1] = ours;
        } else {
            bens[0] = ours;
            bens[1] = proto;
        }
    }
}
