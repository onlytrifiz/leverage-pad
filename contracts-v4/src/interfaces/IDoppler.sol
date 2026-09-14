// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Minimal views of Doppler's Robinhood Chain contracts (docs.doppler.lol/reference/contract-addresses),
 * mirrored from their verified sources. Struct layouts must match byte for byte: the initializer
 * and the Rehype hook `abi.decode` their init data from bytes.
 */
library DopplerTypes {
    /// DopplerERC20V1Factory.create → tokenData
    struct VestingSchedule {
        uint64 cliff;
        uint64 duration;
    }

    /// FeesManager / BeneficiaryData.sol
    struct BeneficiaryData {
        address beneficiary;
        uint96 shares;
    }

    /// Multicurve.sol
    struct Curve {
        int24 tickLower;
        int24 tickUpper;
        uint16 numPositions;
        uint256 shares;
    }

    /// DopplerHookInitializer.InitData
    struct InitializerData {
        uint24 fee;
        int24 tickSpacing;
        int24 farTick;
        Curve[] curves;
        BeneficiaryData[] beneficiaries;
        address dopplerHook;
        bytes onInitializationDopplerHookCalldata;
        bytes graduationDopplerHookCalldata;
    }

    /// RehypeTypes.FeeDistributionInfo (each group of four must sum to 1e18)
    struct FeeDistributionInfo {
        uint256 assetFeesToAssetBuybackWad;
        uint256 assetFeesToNumeraireBuybackWad;
        uint256 assetFeesToBeneficiaryWad;
        uint256 assetFeesToLpWad;
        uint256 numeraireFeesToAssetBuybackWad;
        uint256 numeraireFeesToNumeraireBuybackWad;
        uint256 numeraireFeesToBeneficiaryWad;
        uint256 numeraireFeesToLpWad;
    }

    /// RehypeTypes.InitData (RehypeDopplerHookInitializer 0x5f9e…3215)
    struct RehypeInitData {
        address numeraire;
        address buybackDst;
        uint24 startFee;
        uint24 endFee;
        uint32 durationSeconds;
        uint32 startingTime; // 0 = now
        uint8 feeRoutingMode; // 0 = DirectBuyback
        FeeDistributionInfo feeDistributionInfo;
        BeneficiaryData[] feeBeneficiaries;
    }
}

interface IAirlock {
    struct CreateParams {
        uint256 initialSupply;
        uint256 numTokensToSell;
        address numeraire;
        address tokenFactory;
        bytes tokenFactoryData;
        address governanceFactory;
        bytes governanceFactoryData;
        address poolInitializer;
        bytes poolInitializerData;
        address liquidityMigrator;
        bytes liquidityMigratorData;
        address integrator;
        bytes32 salt;
    }

    function create(CreateParams calldata createData)
        external
        returns (address asset, address pool, address governance, address timelock, address migrationPool);

    function owner() external view returns (address);

    /// 0 = NotWhitelisted, 1 = TokenFactory, 2 = GovernanceFactory, 3 = PoolInitializer, 4 = LiquidityMigrator
    function getModuleState(address module) external view returns (uint8);
}

interface IDopplerHookInitializer {
    /// bit flags: 1 = onInitialization, 2 = onSwap, 4 = onGraduation
    function isDopplerHookEnabled(address dopplerHook) external view returns (uint256);
}

interface IBundler {
    struct VestingParams {
        bool permissionlessClaim;
        uint64 vestingDuration;
        uint64 cliffDuration;
    }

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function bundle(
        IAirlock.CreateParams calldata createData,
        VestingParams calldata vestingData,
        uint128 exactAmountIn,
        address recipient
    ) external payable returns (address asset, PoolKey memory poolKey, address governance, address timelock, uint128 amountOut);
}
