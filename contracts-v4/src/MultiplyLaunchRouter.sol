// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TickMath} from "@v4-core/libraries/TickMath.sol";

import {IAirlock, IDopplerHookInitializer, IRehype} from "./interfaces/IDoppler.sol";
import {MultiplyFeeSink} from "./MultiplyFeeSink.sol";
import {DopplerLaunch} from "./DopplerLaunch.sol";

/**
 * @title MultiplyLaunchRouter
 * @notice Policy router in front of Doppler's Airlock on Robinhood Chain. Anyone can call
 * `launch`; the router builds the whole `CreateParams` so every coin launched through it has
 * the same shape: fixed supply, one-sided pool opening at a chosen market cap, and the trading
 * fee taken by Doppler's Rehype hook so that it always lands in the numeraire: the LP fee is
 * zero, the hook fee is the creator's choice inside the allowed range, and whatever the hook
 * collects in the coin (buys pay their fee in the coin) is swapped into the numeraire inside the
 * same swap and sent to the fee hub. Launch protection is only the schedule: on, the fee starts
 * at `snipeStartFee` and decays linearly to the creator's fee over `snipeSeconds`, both chosen
 * per launch up to the policy's maxima; off, it is flat from the first block.
 * An optional launch buy goes through Doppler's Bundler, which creates the market and swaps in
 * the same call frame so nothing can trade before it; the Rehype exempts that swap from the
 * non-protocol part of the fee. The launcher pays for it and may have its tokens delivered to
 * several wallets (`BuyOrder`).
 *
 * Where the fee lands is fixed per pool at initialization (the hook has no setter for its
 * `buybackDst`), so with a sink configured the router clones a `MultiplyFeeSink` per launch and
 * gives THAT to the hook and to the pool as the 95% beneficiary: every fee of a coin reaches a
 * contract that splits it between the protocol treasury and the coin's own sub-wallet, and burns
 * the coin. Without a sink configured (the state before the upgrade that added it) the policy's
 * fee hub receives everything, as before.
 *
 * The router holds no funds (a launch buy only crosses it inside one call) and
 * never touches a pool after creation: the token, the pool and its lock are Doppler's and are
 * immutable. Upgradeability (UUPS) and the owner-set config therefore only govern FUTURE
 * launches; they keep the address stable for indexers when Doppler rotates a module.
 *
 * Each coin's engine (what its fees trade) is stored here. Market and side are fixed forever.
 * Leverage and take-profit are fixed too unless the coin was launched `managed`: then its
 * creator may retune them, each change announced on-chain and effective only after
 * `managedDelay`, so holders see it coming. The owner may override any coin immediately, the
 * escape hatch for a venue that lowers a market's leverage cap or delists it. Nothing here
 * moves funds: the keeper reads `engineOf` and runs the position accordingly.
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
    uint256 public constant WAD = 1e18;
    uint24 public constant DYNAMIC_FEE_FLAG = 0x800000;
    /// Rehype refuses fees above this (RehypeTypes.MAX_SWAP_FEE), 1e6-based.
    uint24 public constant REHYPE_MAX_FEE = 0.8e6;
    /// Doppler's mandatory beneficiary share for the airlock owner (BeneficiaryData.MIN_PROTOCOL_OWNER_SHARES).
    uint256 public constant DOPPLER_MIN_PROTOCOL_SHARE = 0.05e18;
    int24 public constant MAX_TICK_SPACING = 32767;
    /// Ceiling for `Policy.snipeSeconds`: a window is immutable per coin and taxes sells too.
    uint32 public constant MAX_SNIPE_SECONDS = 1 hours;
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
        uint24 snipeStartFee; // highest opening fee a launch may ask for (800_000 = 80%, the hook's cap)
        uint32 snipeSeconds; // longest decay a launch may ask for
    }

    struct LaunchInput {
        string name;
        string symbol;
        string tokenURI; // IPFS metadata (image, description) for terminals; not read by the keeper
        uint24 fee; // trading fee, 1e6-based, taken by the hook in numeraire
        uint24 snipeStartFee; // opening fee of the protection window; 0 without one
        uint32 snipeSeconds; // length of the protection window, 0 = none (flat fee from the first block)
        uint256 mcap; // 0 = policy default
        uint128 firstBuy; // the launcher's own buy, numeraire raw, 0 = none
        uint128 minOut; // fewest tokens the whole launch buy (firstBuy plus orders) may return, 0 = no floor
        bytes32 salt; // namespaced per launcher below
        // the engine: what the coin's fees will trade. On-chain so the keeper never depends on
        // a gateway to learn it; validated here in the same ranges the keeper accepts.
        string market; // Lighter perp symbol, 2-12 chars of A-Z 0-9 (existence is checked off-chain)
        uint8 side; // 0 = long, 1 = short
        uint8 leverage; // a stop allowed by `engineConfig.leverageMask` (the venue's cap is checked off-chain)
        uint16 takeProfitPct; // each deposit banks at +takeProfitPct% on its collateral
        bool managed; // the creator may retune leverage and take-profit later, after a delay
    }

    /// @notice A wallet that receives part of the launch buy, paid for by the launcher.
    struct BuyOrder {
        address wallet;
        uint128 amount; // numeraire raw spent for this wallet
    }

    uint8 public constant SIDE_LONG = 0;
    uint8 public constant SIDE_SHORT = 1;
    /// upper bound for `EngineConfig.maxTakeProfitPct`: +10,000% (100x the collateral)
    uint16 public constant TAKE_PROFIT_CEILING = 10_000;
    /// upper bound for `EngineConfig.managedDelay`
    uint32 public constant MAX_MANAGED_DELAY = 30 days;

    /// @notice What launches and later changes may set. Owner config, like the policy.
    struct EngineConfig {
        uint64 leverageMask; // bit n set = leverage n allowed (n < 64): 2,3,5,10,20,25,50 today
        uint16 minTakeProfitPct; // +10 today
        uint16 maxTakeProfitPct; // +500 today
        uint32 managedDelay; // seconds between a creator's proposal and its effect (12 h today)
    }

    /// @notice A coin's engine. `pending*` is a managed coin's announced change, effective at
    /// `pendingAt` (0 = none). Read it through `engineOf`, which applies a change already due.
    struct Engine {
        string market;
        uint8 side;
        uint8 leverage;
        uint16 takeProfitPct;
        bool managed;
        address creator;
        uint8 pendingLeverage;
        uint16 pendingTakeProfitPct;
        uint64 pendingAt;
    }

    /// @notice Per-coin fee sink. `implementation == 0` disables it (fees go to `policy.feeHub`).
    struct SinkConfig {
        address implementation; // MultiplyFeeSink built for this router (its ROUTER must be this proxy)
        address keeper; // may set each sink's destination once, and sweep stray tokens
        address treasury; // receives the protocol share of every flush
        uint16 treasuryBps; // protocol share, in bps of the whole trading fee (2500 = 25%)
    }

    /// @custom:storage-location erc7201:multiply.launch-router
    struct RouterStorage {
        Modules modules;
        Policy policy;
        // appended by the sink upgrade: the members above keep their slots
        SinkConfig sink;
        mapping(address asset => address sink) sinkOf;
        // appended by the engine upgrade
        EngineConfig engineConfig;
        mapping(address asset => Engine) engines;
    }

    // keccak256(abi.encode(uint256(keccak256("multiply.launch-router")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x42c4973d32e24b31a6eefee371c6afa2e92a3c4c526c47d5e7db95f4a132f900;

    /// @notice `antiSnipe` = launched with a protection window (its schedule is on the Rehype:
    /// `getFeeSchedule(poolId)`). `firstBuy` and `firstBuyOut` are the WHOLE launch buy, of every
    /// wallet; with orders, `DopplerLaunch.LaunchBuy` carries each wallet's part.
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
    /// @notice The coin's engine at launch. Later changes arrive as the two events below.
    event MultiplyEngine(
        address indexed asset,
        string market,
        uint8 side,
        uint8 leverage,
        uint16 takeProfitPct,
        bool managed,
        address indexed creator
    );
    /// @notice A managed coin's creator announced a change, effective at `effectiveAt`.
    event EngineProposed(address indexed asset, uint8 leverage, uint16 takeProfitPct, uint64 effectiveAt);
    event EngineProposalCancelled(address indexed asset, address indexed by);
    /// @notice The owner retuned a coin, effective immediately (pending proposal dropped).
    event EngineOverridden(address indexed asset, uint8 leverage, uint16 takeProfitPct, address indexed by);
    event ModulesSet(Modules modules);
    event PolicySet(Policy policy);
    event SinkConfigSet(SinkConfig config);
    event EngineConfigSet(EngineConfig config);

    error FeeOutOfRange(uint24 fee, uint24 min, uint24 max);
    error InvalidSnipe(uint24 startFee, uint32 secs);
    error InvalidSinkConfig();
    error InvalidEngine();
    error InvalidEngineConfig();
    error UnknownCoin(address asset);
    error NotManaged(address asset);
    error NotCreator(address asset);
    error NothingPending(address asset);
    error McapOutOfRange(uint256 mcap, uint256 min, uint256 max);
    error EmptyName();
    error TickOutOfRange(int24 tick);
    error ZeroAddress();
    error InvalidPolicy();
    error ModuleNotWhitelisted(address module, uint8 expectedState);
    error RehypeNotEnabled(address rehype);
    error FeeHubIsProtocolOwner(address hub);
    error BundlerMismatch(address bundler);

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
     * @notice Launches a coin. Returns the token, its v4 pool id and the tokens bought by the
     * launch buy, if there is one.
     *
     * The launch buy is `input.firstBuy` (tokens to the caller) plus every order (tokens to that
     * wallet): one swap, the same average price for all, handed out pro rata. The caller pays for
     * all of it and must have approved the sum to this router. 32 orders at most. The opening
     * price follows the policy when `mcap` is 0, so a buyer sets `minOut`.
     */
    function launch(LaunchInput calldata input, BuyOrder[] calldata orders)
        external
        whenNotPaused
        nonReentrant
        returns (address asset, bytes32 poolId, uint128 totalOut)
    {
        RouterStorage storage $ = _s();
        Policy memory p = $.policy;
        Modules memory m = $.modules;

        if (bytes(input.name).length == 0 || bytes(input.symbol).length == 0) revert EmptyName();
        if (!validEngine(input.market, input.side, input.leverage, input.takeProfitPct)) revert InvalidEngine();
        if (input.fee < p.minFee || input.fee > p.maxFee) revert FeeOutOfRange(input.fee, p.minFee, p.maxFee);
        uint256 mcap = input.mcap == 0 ? p.defaultMcap : input.mcap;
        if (mcap < p.minMcap || mcap > p.maxMcap) revert McapOutOfRange(mcap, p.minMcap, p.maxMcap);

        if (
            input.snipeSeconds == 0
                ? input.snipeStartFee != 0
                : input.snipeSeconds > p.snipeSeconds || input.snipeStartFee > p.snipeStartFee
                    || input.snipeStartFee <= input.fee
        ) revert InvalidSnipe(input.snipeStartFee, input.snipeSeconds);

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

        uint128 totalIn;
        (asset, totalIn, totalOut) = DopplerLaunch.execute(input, orders, p, m, DopplerLaunch.Opening(hub, tick, maxTick));

        poolId = _poolId(asset, p.numeraire, DYNAMIC_FEE_FLAG, p.tickSpacing, m.poolInitializer);
        emit MultiplyLaunch(
            asset, msg.sender, poolId, input.fee, input.snipeSeconds != 0, mcap, tick, totalIn, totalOut, input.tokenURI
        );

        Engine storage e = $.engines[asset];
        e.market = input.market;
        e.side = input.side;
        e.leverage = input.leverage;
        e.takeProfitPct = input.takeProfitPct;
        e.managed = input.managed;
        e.creator = msg.sender;
        emit MultiplyEngine(
            asset, input.market, input.side, input.leverage, input.takeProfitPct, input.managed, msg.sender
        );

        if (sink != address(0)) {
            MultiplyFeeSink(sink).initialize(asset, p.numeraire, s.treasuryBps, SINK_RECEIVED_BPS);
            $.sinkOf[asset] = sink;
            emit FeeSink(asset, sink);
        }
    }

    /// @notice The engine ranges launches accept: market 2-12 chars of [A-Z0-9], side 0/1,
    /// leverage and take-profit inside `engineConfig`.
    function validEngine(string calldata market, uint8 side, uint8 leverage, uint16 takeProfitPct)
        public
        view
        returns (bool)
    {
        bytes calldata m = bytes(market);
        if (m.length < 2 || m.length > 12) return false;
        for (uint256 i; i < m.length; i++) {
            bytes1 c = m[i];
            if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A))) return false;
        }
        if (side > SIDE_SHORT) return false;
        return validTuning(leverage, takeProfitPct);
    }

    /// @notice Leverage and take-profit inside the owner's bounds: what launches, proposals and
    /// overrides may set.
    function validTuning(uint8 leverage, uint16 takeProfitPct) public view returns (bool) {
        EngineConfig storage c = _s().engineConfig;
        if (takeProfitPct < c.minTakeProfitPct || takeProfitPct > c.maxTakeProfitPct) return false;
        return leverage < 64 && (c.leverageMask >> leverage) & 1 == 1;
    }

    // ──────────────────────────────────────────────────────────── engine ──

    /**
     * @notice A managed coin's creator announces new leverage and take-profit. They take effect
     * after `managedDelay`; a new proposal replaces the previous one and restarts the clock (one
     * already due has become current first). Market and side can never change.
     */
    function proposeEngine(address asset, uint8 leverage, uint16 takeProfitPct) external whenNotPaused {
        Engine storage e = _s().engines[asset];
        if (e.creator == address(0)) revert UnknownCoin(asset);
        if (!e.managed) revert NotManaged(asset);
        if (msg.sender != e.creator) revert NotCreator(asset);
        if (!validTuning(leverage, takeProfitPct)) revert InvalidEngine();
        _settle(e);
        uint64 at = uint64(block.timestamp) + _s().engineConfig.managedDelay;
        e.pendingLeverage = leverage;
        e.pendingTakeProfitPct = takeProfitPct;
        e.pendingAt = at;
        emit EngineProposed(asset, leverage, takeProfitPct, at);
    }

    /// @notice Withdraws a proposal not yet in effect. The creator or the owner.
    function cancelEngineProposal(address asset) external {
        Engine storage e = _s().engines[asset];
        if (e.creator == address(0)) revert UnknownCoin(asset);
        if (msg.sender != e.creator && msg.sender != owner()) revert NotCreator(asset);
        if (e.pendingAt == 0 || block.timestamp >= e.pendingAt) revert NothingPending(asset);
        _clearPending(e);
        emit EngineProposalCancelled(asset, msg.sender);
    }

    /// @notice The owner retunes any coin, managed or not, effective immediately.
    function overrideEngine(address asset, uint8 leverage, uint16 takeProfitPct) external onlyOwner {
        Engine storage e = _s().engines[asset];
        if (e.creator == address(0)) revert UnknownCoin(asset);
        if (!validTuning(leverage, takeProfitPct)) revert InvalidEngine();
        e.leverage = leverage;
        e.takeProfitPct = takeProfitPct;
        _clearPending(e);
        emit EngineOverridden(asset, leverage, takeProfitPct, msg.sender);
    }

    /// @notice A coin's engine as it stands now: a proposal already due is shown as current,
    /// one still in the future as pending. Zero creator = not launched here.
    function engineOf(address asset) external view returns (Engine memory e) {
        e = _s().engines[asset];
        if (e.pendingAt != 0 && block.timestamp >= e.pendingAt) {
            e.leverage = e.pendingLeverage;
            e.takeProfitPct = e.pendingTakeProfitPct;
            e.pendingLeverage = 0;
            e.pendingTakeProfitPct = 0;
            e.pendingAt = 0;
        }
    }

    function _settle(Engine storage e) private {
        if (e.pendingAt != 0 && block.timestamp >= e.pendingAt) {
            e.leverage = e.pendingLeverage;
            e.takeProfitPct = e.pendingTakeProfitPct;
            _clearPending(e);
        }
    }

    function _clearPending(Engine storage e) private {
        e.pendingLeverage = 0;
        e.pendingTakeProfitPct = 0;
        e.pendingAt = 0;
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

    /// @notice Salt actually sent to the Airlock: namespaced per launcher, so two launchers never
    /// collide. Not secret: whoever learns a salt before its launch can create that token address
    /// through the Airlock directly and make the launch revert, so salts must be random.
    function saltFor(address launcher, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(launcher, salt));
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

    /// @notice Bounds for engines: launches and proposals after this call. Coins already running
    /// keep their values (an override or a proposal must itself fit the new bounds).
    function setEngineConfig(EngineConfig calldata config) external onlyOwner {
        if (
            config.leverageMask == 0 || config.leverageMask & 3 != 0 // no 0x, no 1x
                || config.minTakeProfitPct == 0 || config.minTakeProfitPct > config.maxTakeProfitPct
                || config.maxTakeProfitPct > TAKE_PROFIT_CEILING || config.managedDelay > MAX_MANAGED_DELAY
        ) revert InvalidEngineConfig();
        _s().engineConfig = config;
        emit EngineConfigSet(config);
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

    function engineConfig() external view returns (EngineConfig memory) {
        return _s().engineConfig;
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
        // the hook exempts this bundler's swap and no other: a mismatch would charge every launch
        // buy the full opening fee without failing
        if (IRehype(m.rehype).bundler() != m.bundler) revert BundlerMismatch(m.bundler);
        _s().modules = m;
        emit ModulesSet(m);
    }

    function _setPolicy(Policy calldata p) internal {
        if (p.numeraire == address(0) || p.feeHub == address(0)) revert ZeroAddress();
        if (
            p.supply == 0 || p.tickSpacing <= 0 || p.tickSpacing > MAX_TICK_SPACING || p.minFee > p.maxFee
                || p.maxFee > REHYPE_MAX_FEE || p.snipeStartFee > REHYPE_MAX_FEE || p.snipeStartFee < p.maxFee
                || p.snipeSeconds == 0 || p.snipeSeconds > MAX_SNIPE_SECONDS || p.minMcap > p.maxMcap || p.defaultMcap < p.minMcap
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
