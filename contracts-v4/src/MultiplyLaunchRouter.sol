// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TickMath} from "@v4-core/libraries/TickMath.sol";

import {IAirlock, IBundler, IDopplerHookInitializer, DopplerTypes} from "./interfaces/IDoppler.sol";
import {MultiplyFeeSink} from "./MultiplyFeeSink.sol";

/**
 * @title MultiplyLaunchRouter
 * @notice Policy router in front of Doppler's Airlock on Robinhood Chain. Anyone can call
 * `launch`; the router builds the whole `CreateParams` so every coin launched through it has
 * the same shape: fixed supply, one-sided pool opening at a chosen market cap, and the trading
 * fee taken by Doppler's Rehype hook so that it always lands in the numeraire: the LP fee is
 * zero, the hook fee is the creator's choice inside the allowed range, and whatever the hook
 * collects in the coin (buys pay their fee in the coin) is swapped into the numeraire inside the
 * same swap and sent to the fee hub. Launch protection is only the schedule: on, the fee starts
 * high and decays to the creator's fee over a few seconds; off, it is flat from the first block.
 * An optional first buy goes through Doppler's Bundler, which creates the market and swaps in
 * the same call frame so nothing can trade before it; the Rehype exempts that swap from the
 * non-protocol part of the fee.
 *
 * Where the fee lands is fixed per pool at initialization (the hook has no setter for its
 * `buybackDst`), so with a sink configured the router clones a `MultiplyFeeSink` per launch and
 * gives THAT to the hook and to the pool as the 95% beneficiary: every fee of a coin reaches a
 * contract that splits it between the protocol treasury and the coin's own sub-wallet, and burns
 * the coin. Without a sink configured (the state before the upgrade that added it) the policy's
 * fee hub receives everything, as before.
 *
 * The router holds no funds (the first buy's numeraire only crosses it inside one call) and
 * never touches a pool after creation: the token, the pool and its lock are Doppler's and are
 * immutable. Upgradeability (UUPS) and the owner-set config therefore only govern FUTURE
 * launches; they keep the address stable for indexers when Doppler rotates a module.
 *
 * Time is `block.timestamp` only: on Robinhood Chain `block.number` is the L1 block number.
 */
contract MultiplyLaunchRouter is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint24 public constant DYNAMIC_FEE_FLAG = 0x800000;
    /// Rehype refuses fees above this (RehypeTypes.MAX_SWAP_FEE), 1e6-based.
    uint24 public constant REHYPE_MAX_FEE = 0.8e6;
    /// Doppler's mandatory beneficiary share for the airlock owner (BeneficiaryData.MIN_PROTOCOL_OWNER_SHARES).
    uint256 public constant DOPPLER_MIN_PROTOCOL_SHARE = 0.05e18;
    int24 public constant MAX_TICK_SPACING = 32767;
    uint16 public constant BPS = 10_000;
    /// Doppler's slice of every Rehype hook fee, kept on the hook before anything reaches buybackDst.
    uint16 public constant REHYPE_PROTOCOL_BPS = 500;
    /// What a sink actually receives of the trading fee: the hook fee less Doppler's slice.
    uint16 public constant SINK_RECEIVED_BPS = BPS - REHYPE_PROTOCOL_BPS;

    /// @notice Doppler modules the router launches with. All must be whitelisted on the Airlock.
    struct Modules {
        address airlock;
        address bundler;
        address tokenFactory;
        address governanceFactory;
        address poolInitializer;
        address liquidityMigrator;
        address rehype;
    }

    /// @notice Launch economics. Market caps are in raw numeraire units (USDG: 6 decimals).
    struct Policy {
        address numeraire;
        address feeHub; // receives every fee, in numeraire, until the keeper adopts the coin (Rehype buybackDst)
        uint256 protocolShareWad; // Doppler's mandatory beneficiary minimum (0.05e18 today)
        uint256 supply; // fixed supply of every coin, raw (1e27 = 1B with 18 decimals)
        uint256 defaultMcap;
        uint256 minMcap;
        uint256 maxMcap;
        uint24 minFee; // Rehype hook fee, 1e6-based (30_000 = 3%); the hook caps it at 0.8e6
        uint24 maxFee;
        int24 tickSpacing;
        uint24 snipeStartFee; // opening fee with protection on (800_000 = 80%, the hook's cap)
        uint32 snipeSeconds; // decay length with protection on
    }

    struct LaunchInput {
        string name;
        string symbol;
        string tokenURI; // IPFS metadata (image, description) for terminals; not read by the keeper
        uint24 fee; // trading fee, 1e6-based, taken by the hook in numeraire
        bool antiSnipe; // decaying opening fee (schedule only; the hook is always attached)
        uint256 mcap; // 0 = policy default
        uint128 firstBuy; // numeraire raw, 0 = no first buy
        bytes32 salt; // namespaced per launcher below
        // the engine: what the coin's fees will trade. On-chain so the keeper never depends on
        // a gateway to learn it; validated here in the same ranges the keeper accepts.
        string market; // Lighter perp symbol, 2-12 chars of A-Z 0-9 (existence is checked off-chain)
        uint8 side; // 0 = long, 1 = short
        uint8 leverage; // one of 2, 3, 5, 10, 20
        uint8 risk; // 0 = safe (+20%), 1 = balanced (+50%), 2 = degen (+100%)
    }

    uint8 public constant SIDE_LONG = 0;
    uint8 public constant SIDE_SHORT = 1;
    uint8 public constant RISK_MAX = 2;
    /// bit n set = leverage n allowed: 2, 3, 5, 10, 20
    uint32 public constant LEVERAGE_MASK = (1 << 2) | (1 << 3) | (1 << 5) | (1 << 10) | (1 << 20);

    /// @notice Per-coin fee sink. `implementation == 0` disables it (fees go to `policy.feeHub`).
    struct SinkConfig {
        address implementation; // MultiplyFeeSink built for this router (its ROUTER must be this proxy)
        address keeper; // may set each sink's destination once, and sweep stray tokens
        address treasury; // receives the protocol share of every flush
        uint16 treasuryBps; // protocol share, in bps of the whole trading fee (1500 = 15%)
    }

    /// @custom:storage-location erc7201:multiply.launch-router
    struct RouterStorage {
        Modules modules;
        Policy policy;
        // appended by the sink upgrade: the members above keep their slots
        SinkConfig sink;
        mapping(address asset => address sink) sinkOf;
    }

    // keccak256(abi.encode(uint256(keccak256("multiply.launch-router")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x42c4973d32e24b31a6eefee371c6afa2e92a3c4c526c47d5e7db95f4a132f900;

    event MultiplyLaunch(
        address indexed asset,
        address indexed launcher,
        bytes32 indexed poolId,
        uint24 fee,
        bool antiSnipe,
        uint256 mcap,
        int24 tick,
        uint128 firstBuy,
        uint128 firstBuyOut,
        string tokenURI
    );
    event FeeSink(address indexed asset, address indexed sink);
    /// @notice The coin's engine, fixed at launch. The keeper reads this, nothing else.
    event MultiplyEngine(address indexed asset, string market, uint8 side, uint8 leverage, uint8 risk);
    event ModulesSet(Modules modules);
    event PolicySet(Policy policy);
    event SinkConfigSet(SinkConfig config);

    error FeeOutOfRange(uint24 fee, uint24 min, uint24 max);
    error InvalidSinkConfig();
    error InvalidEngine();
    error McapOutOfRange(uint256 mcap, uint256 min, uint256 max);
    error EmptyName();
    error TickOutOfRange(int24 tick);
    error ZeroAddress();
    error InvalidPolicy();
    error ModuleNotWhitelisted(address module, uint8 expectedState);
    error RehypeNotEnabled(address rehype);
    error FeeHubIsProtocolOwner(address hub);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, Modules calldata modules_, Policy calldata policy_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();
        _setModules(modules_);
        _setPolicy(policy_);
    }

    // ───────────────────────────────────────────────────────────── launch ──

    /**
     * @notice Launches a coin. Returns the token, its v4 pool id and, with a first buy, the
     * tokens bought. With `firstBuy > 0` the caller must have approved `firstBuy` numeraire
     * to this router; the bought tokens go to the caller.
     */
    function launch(LaunchInput calldata input)
        external
        whenNotPaused
        nonReentrant
        returns (address asset, bytes32 poolId, uint128 firstBuyOut)
    {
        RouterStorage storage $ = _s();
        Policy memory p = $.policy;
        Modules memory m = $.modules;

        if (bytes(input.name).length == 0 || bytes(input.symbol).length == 0) revert EmptyName();
        if (!validEngine(input.market, input.side, input.leverage, input.risk)) revert InvalidEngine();
        if (input.fee < p.minFee || input.fee > p.maxFee) revert FeeOutOfRange(input.fee, p.minFee, p.maxFee);
        uint256 mcap = input.mcap == 0 ? p.defaultMcap : input.mcap;
        if (mcap < p.minMcap || mcap > p.maxMcap) revert McapOutOfRange(mcap, p.minMcap, p.maxMcap);

        (int24 tick, int24 maxTick) = tickForMcap(mcap);

        // The sink must exist before the Airlock call: the hook reads `buybackDst` at
        // initialization. Its address depends only on the launcher and salt, so the frontend can
        // show it beforehand (`predictSink`). The clone is bound to the token afterwards.
        address sink;
        address hub = p.feeHub;
        SinkConfig memory s = $.sink;
        if (s.implementation != address(0)) {
            sink = Clones.cloneDeterministic(s.implementation, saltFor(msg.sender, input.salt));
            hub = sink;
        }

        IAirlock.CreateParams memory params = _buildCreateParams(input, p, m, hub, tick, maxTick);

        if (input.firstBuy == 0) {
            (asset,,,,) = IAirlock(m.airlock).create(params);
        } else {
            IERC20(p.numeraire).safeTransferFrom(msg.sender, address(this), input.firstBuy);
            IERC20(p.numeraire).forceApprove(m.bundler, input.firstBuy);
            (asset,,,, firstBuyOut) = IBundler(m.bundler).bundle(
                params, IBundler.VestingParams({permissionlessClaim: false, vestingDuration: 0, cliffDuration: 0}), input.firstBuy, msg.sender
            );
            IERC20(p.numeraire).forceApprove(m.bundler, 0);
        }

        poolId = _poolId(asset, p.numeraire, DYNAMIC_FEE_FLAG, p.tickSpacing, m.poolInitializer);
        emit MultiplyLaunch(
            asset, msg.sender, poolId, input.fee, input.antiSnipe, mcap, tick, input.firstBuy, firstBuyOut, input.tokenURI
        );

        emit MultiplyEngine(asset, input.market, input.side, input.leverage, input.risk);

        if (sink != address(0)) {
            MultiplyFeeSink(sink).initialize(asset, p.numeraire, s.treasuryBps, SINK_RECEIVED_BPS);
            $.sinkOf[asset] = sink;
            emit FeeSink(asset, sink);
        }
    }

    /// @notice The engine ranges the keeper serves: market 2-12 chars of [A-Z0-9], side 0/1,
    /// leverage in {2,3,5,10,20}, risk 0-2.
    function validEngine(string calldata market, uint8 side, uint8 leverage, uint8 risk) public pure returns (bool) {
        bytes calldata m = bytes(market);
        if (m.length < 2 || m.length > 12) return false;
        for (uint256 i; i < m.length; i++) {
            bytes1 c = m[i];
            if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A))) return false;
        }
        if (side > SIDE_SHORT || risk > RISK_MAX) return false;
        return leverage < 32 && (LEVERAGE_MASK >> leverage) & 1 == 1;
    }

    /// @notice The sink a launch by `launcher` with `salt` will get (zero when sinks are disabled).
    function predictSink(address launcher, bytes32 salt) external view returns (address) {
        address impl = _s().sink.implementation;
        if (impl == address(0)) return address(0);
        return Clones.predictDeterministicAddress(impl, saltFor(launcher, salt), address(this));
    }

    /**
     * @notice Launch tick for a market cap: the price (numeraire per asset, raw units) is
     * `mcap / supply`, so `sqrtPriceX96 = sqrt(mcap * 2^192 / supply)`. Rounded to the nearest
     * tick spacing. Curves are expressed with the asset as token0; Doppler flips them if needed.
     */
    function tickForMcap(uint256 mcap) public view returns (int24 tick, int24 maxTick) {
        Policy storage p = _s().policy;
        int24 spacing = p.tickSpacing;
        uint256 ratioX192 = Math.mulDiv(mcap, 1 << 192, p.supply);
        uint256 sqrtRatio = Math.sqrt(ratioX192);
        if (sqrtRatio < TickMath.MIN_SQRT_PRICE || sqrtRatio > TickMath.MAX_SQRT_PRICE) revert TickOutOfRange(0);
        uint160 sqrtPriceX96 = uint160(sqrtRatio);
        int24 raw = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
        int24 rem = raw % spacing;
        if (rem < 0) rem += spacing;
        tick = raw - rem;
        if (rem * 2 >= spacing) tick += spacing;
        maxTick = (TickMath.MAX_TICK / spacing) * spacing;
        if (tick <= -maxTick || tick >= maxTick) revert TickOutOfRange(tick);
    }

    /// @notice Salt actually sent to the Airlock: namespaced per launcher so nobody can burn someone else's salt.
    function saltFor(address launcher, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(launcher, salt));
    }

    /// @dev `hub` is where every fee of this coin lands: its sink, or the policy fee hub when
    /// sinks are disabled. It is the hook's `buybackDst`, the pool's 95% beneficiary and the
    /// Airlock integrator, so nothing about the coin's fees ever points anywhere else.
    function _buildCreateParams(
        LaunchInput calldata input,
        Policy memory p,
        Modules memory m,
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
        r.startFee = input.antiSnipe ? p.snipeStartFee : input.fee;
        r.endFee = input.fee;
        r.durationSeconds = input.antiSnipe ? p.snipeSeconds : 0;
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
            salt: saltFor(msg.sender, input.salt)
        });
    }

    /// @dev Doppler requires beneficiaries sorted by address and summing to WAD, protocol owner included.
    function _beneficiaries(address protocolOwner, address hub, uint256 protocolShareWad)
        internal
        pure
        returns (DopplerTypes.BeneficiaryData[] memory bens)
    {
        if (protocolOwner == hub) revert FeeHubIsProtocolOwner(hub);
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

    function _poolId(address asset, address numeraire, uint24 fee, int24 tickSpacing, address hooks)
        internal
        pure
        returns (bytes32)
    {
        (address c0, address c1) = asset < numeraire ? (asset, numeraire) : (numeraire, asset);
        return keccak256(abi.encode(c0, c1, fee, tickSpacing, hooks));
    }

    // ────────────────────────────────────────────────────────────── admin ──

    function setModules(Modules calldata modules_) external onlyOwner {
        _setModules(modules_);
    }

    function setPolicy(Policy calldata policy_) external onlyOwner {
        _setPolicy(policy_);
    }

    /// @notice Enables (or reconfigures) per-coin sinks for FUTURE launches. Sinks already
    /// deployed keep their split; only the keeper and treasury addresses are read live.
    function setSinkConfig(SinkConfig calldata config) external onlyOwner {
        if (config.implementation == address(0) || config.keeper == address(0) || config.treasury == address(0)) {
            revert ZeroAddress();
        }
        if (config.implementation.code.length == 0 || MultiplyFeeSink(config.implementation).ROUTER() != address(this)) {
            revert InvalidSinkConfig();
        }
        if (config.treasuryBps > SINK_RECEIVED_BPS) revert InvalidSinkConfig();
        _s().sink = config;
        emit SinkConfigSet(config);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function modules() external view returns (Modules memory) {
        return _s().modules;
    }

    function policy() external view returns (Policy memory) {
        return _s().policy;
    }

    function sinkConfig() external view returns (SinkConfig memory) {
        return _s().sink;
    }

    /// @notice The fee sink of a coin launched here, zero if it predates sinks.
    function sinkOf(address asset) external view returns (address) {
        return _s().sinkOf[asset];
    }

    /// @notice Read by every sink at `setDestination` / `sweep`.
    function keeper() external view returns (address) {
        return _s().sink.keeper;
    }

    /// @notice Read by every sink at `flush`.
    function treasury() external view returns (address) {
        return _s().sink.treasury;
    }

    function _setModules(Modules calldata m) internal {
        if (
            m.airlock == address(0) || m.bundler == address(0) || m.tokenFactory == address(0)
                || m.governanceFactory == address(0) || m.poolInitializer == address(0)
                || m.liquidityMigrator == address(0) || m.rehype == address(0)
        ) revert ZeroAddress();
        IAirlock a = IAirlock(m.airlock);
        if (a.getModuleState(m.tokenFactory) != 1) revert ModuleNotWhitelisted(m.tokenFactory, 1);
        if (a.getModuleState(m.governanceFactory) != 2) revert ModuleNotWhitelisted(m.governanceFactory, 2);
        if (a.getModuleState(m.poolInitializer) != 3) revert ModuleNotWhitelisted(m.poolInitializer, 3);
        if (a.getModuleState(m.liquidityMigrator) != 4) revert ModuleNotWhitelisted(m.liquidityMigrator, 4);
        // the hook must be enabled for both initialization (1) and swaps (2) on the initializer
        if (IDopplerHookInitializer(m.poolInitializer).isDopplerHookEnabled(m.rehype) & 3 != 3) revert RehypeNotEnabled(m.rehype);
        _s().modules = m;
        emit ModulesSet(m);
    }

    function _setPolicy(Policy calldata p) internal {
        if (p.numeraire == address(0) || p.feeHub == address(0)) revert ZeroAddress();
        if (
            p.supply == 0 || p.tickSpacing <= 0 || p.tickSpacing > MAX_TICK_SPACING || p.minFee > p.maxFee
                || p.maxFee > REHYPE_MAX_FEE || p.snipeStartFee > REHYPE_MAX_FEE || p.snipeStartFee < p.maxFee
                || p.snipeSeconds == 0 || p.minMcap > p.maxMcap || p.defaultMcap < p.minMcap
                || p.defaultMcap > p.maxMcap || p.protocolShareWad < DOPPLER_MIN_PROTOCOL_SHARE
                || p.protocolShareWad >= WAD || p.protocolShareWad > type(uint96).max
        ) revert InvalidPolicy();
        _s().policy = p;
        emit PolicySet(p);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _s() private pure returns (RouterStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }
}
