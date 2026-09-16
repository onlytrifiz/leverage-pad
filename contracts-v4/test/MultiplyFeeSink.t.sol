// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MultiplyLaunchRouter} from "../src/MultiplyLaunchRouter.sol";
import {MultiplyFeeSink} from "../src/MultiplyFeeSink.sol";
import {Swapper, PoolKey, IInitializerView, IRehypeView, IUUPS} from "./MultiplyLaunchRouter.t.sol";

interface IRehypePoolInfo {
    function getPoolInfo(bytes32 poolId) external view returns (address asset, address numeraire, address buybackDst);
    function setFeeDistribution(bytes32 poolId, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
        external;
}

/// Fork tests for the per-coin fee sink, against Doppler's live Robinhood Chain deployment:
///   FOUNDRY_PROFILE=fork forge test --match-contract MultiplyFeeSinkFork -vv   (ROBINHOOD_RPC_URL set)
contract MultiplyFeeSinkFork is Test {
    address constant AIRLOCK = 0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862;
    address constant BUNDLER = 0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c;
    address constant TOKEN_FACTORY = 0x1B37D3a72082029c44B35B604Ea473617580b69a;
    address constant NOOP_GOV = 0x85f37f74Ef2478A770318bc810177a9835911aD7;
    address constant INITIALIZER = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    address constant NOOP_MIGRATOR = 0xba2F330EDb16cD8056f5988d8CE19BbC63475A0e;
    address constant REHYPE = 0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215;
    address constant DOPPLER_SAFE = 0x21E2ce70511e4FE542a97708e89520471DAa7A66;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant DEPLOYER = 0x23Bf247B662EFADf114642A65DbbB0CB7D0EBAc0; // holds USDG on the fork
    /// The router proxy live on Robinhood Chain (owner = DEPLOYER), for the upgrade test.
    address constant LIVE_ROUTER = 0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd;
    uint24 constant DYNAMIC = 0x800000;
    uint16 constant TREASURY_BPS = 1500; // 15% of the trading fee to the protocol, 80% to the engine

    MultiplyLaunchRouter router;
    MultiplyFeeSink sinkImpl;
    Swapper swapper;
    address owner = makeAddr("owner");
    address launcher = makeAddr("launcher");
    address hub = makeAddr("hub");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address subWallet = makeAddr("subWallet");
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(vm.envString("ROBINHOOD_RPC_URL"));
        router = _freshRouter();
        sinkImpl = new MultiplyFeeSink(address(router));
        vm.prank(owner);
        router.setSinkConfig(_config(address(sinkImpl)));
        swapper = new Swapper(POOL_MANAGER);
        vm.deal(launcher, 1 ether);
        vm.prank(DEPLOYER);
        IERC20(USDG).transfer(trader, 10e6);
    }

    // ───────────────────────────────────────────────────────────── helpers ──

    function _freshRouter() internal returns (MultiplyLaunchRouter r) {
        MultiplyLaunchRouter impl = new MultiplyLaunchRouter();
        bytes memory init = abi.encodeCall(
            MultiplyLaunchRouter.initialize,
            (
                owner,
                MultiplyLaunchRouter.Modules({
                    airlock: AIRLOCK,
                    bundler: BUNDLER,
                    tokenFactory: TOKEN_FACTORY,
                    governanceFactory: NOOP_GOV,
                    poolInitializer: INITIALIZER,
                    liquidityMigrator: NOOP_MIGRATOR,
                    rehype: REHYPE
                }),
                MultiplyLaunchRouter.Policy({
                    numeraire: USDG,
                    feeHub: hub,
                    protocolShareWad: 0.05e18,
                    supply: 1e27,
                    defaultMcap: 4_000e6,
                    minMcap: 1_000e6,
                    maxMcap: 100_000e6,
                    minFee: 10_000,
                    maxFee: 50_000,
                    tickSpacing: 200,
                    snipeStartFee: 800_000,
                    snipeSeconds: 10
                })
            )
        );
        r = MultiplyLaunchRouter(address(new ERC1967Proxy(address(impl), init)));
    }

    function _config(address impl) internal view returns (MultiplyLaunchRouter.SinkConfig memory) {
        return MultiplyLaunchRouter.SinkConfig({implementation: impl, keeper: keeper, treasury: treasury, treasuryBps: TREASURY_BPS});
    }

    function _key(address asset) internal pure returns (PoolKey memory) {
        (address c0, address c1) = asset < USDG ? (asset, USDG) : (USDG, asset);
        return PoolKey({currency0: c0, currency1: c1, fee: DYNAMIC, tickSpacing: 200, hooks: INITIALIZER});
    }

    function _input(string memory name, string memory symbol, uint24 fee, uint128 firstBuy, bytes32 salt)
        internal
        pure
        returns (MultiplyLaunchRouter.LaunchInput memory)
    {
        return MultiplyLaunchRouter.LaunchInput({
            name: name,
            symbol: symbol,
            tokenURI: "ipfs://bafkreiazkosvsyrp24xbvqeoyihoxbidgbt24ih24ter26lj5mez36amw4",
            fee: fee,
            antiSnipe: false,
            mcap: 0,
            firstBuy: firstBuy,
            salt: salt,
            market: "NVDA",
            side: 0,
            leverage: 3,
            risk: 1
        });
    }

    function _launch(MultiplyLaunchRouter r, string memory sym, bytes32 salt)
        internal
        returns (address asset, bytes32 poolId, MultiplyFeeSink sink)
    {
        vm.prank(launcher);
        (asset, poolId,) = r.launch(_input(sym, sym, 30_000, 0, salt));
        sink = MultiplyFeeSink(r.sinkOf(asset));
    }

    /// buys `usdg` of `asset` from the trader; returns the coins received
    function _buy(address asset, uint256 usdg) internal returns (uint256 out) {
        vm.startPrank(trader);
        IERC20(USDG).transfer(address(swapper), usdg);
        out = swapper.swap(_key(asset), USDG < asset, usdg);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────── tests ──

    function test_launch_clonesSink_boundToHookAndPool() public {
        bytes32 salt = keccak256("sink-one");
        address predicted = router.predictSink(launcher, salt);
        (address asset, bytes32 poolId, MultiplyFeeSink sink) = _launch(router, "SNK1", salt);

        assertEq(address(sink), predicted, "sink address is known before the launch");
        assertGt(address(sink).code.length, 0, "sink deployed");
        assertEq(sink.asset(), asset, "bound to the token");
        assertEq(sink.numeraire(), USDG);
        assertEq(sink.treasuryBps(), TREASURY_BPS);
        assertEq(sink.receivedBps(), 9500, "the hook keeps Doppler's 5% before sending");
        assertEq(sink.destination(), address(0), "not adopted yet");
        assertEq(sink.ROUTER(), address(router));

        (,, address buybackDst) = IRehypePoolInfo(REHYPE).getPoolInfo(poolId);
        assertEq(buybackDst, address(sink), "the hook sends every fee to the sink");
        IInitializerView.Ben[] memory bens = IInitializerView(INITIALIZER).getBeneficiaries(asset);
        assertEq(bens.length, 2);
        for (uint256 i; i < 2; i++) {
            if (bens[i].beneficiary == address(sink)) assertEq(bens[i].shares, 0.95e18, "sink is the 95% beneficiary");
            else assertEq(bens[i].beneficiary, DOPPLER_SAFE, "the other one is Doppler");
        }
    }

    function test_sink_initialize_onlyRouter_once() public {
        (address asset,, MultiplyFeeSink sink) = _launch(router, "SNK2", keccak256("sink-two"));
        vm.expectRevert(MultiplyFeeSink.NotRouter.selector);
        sink.initialize(asset, USDG, 1, 9500);
        vm.prank(address(router));
        vm.expectRevert(MultiplyFeeSink.AlreadyInitialized.selector);
        sink.initialize(asset, USDG, 1, 9500);
        // the implementation itself cannot be initialized by anyone but the router either
        vm.expectRevert(MultiplyFeeSink.NotRouter.selector);
        sinkImpl.initialize(asset, USDG, 1, 9500);
    }

    /// The whole point: a buy's fee lands on the sink in USDG, and `flush` splits it 15/80 of the
    /// trading fee (i.e. 15/95 of what the sink received) between treasury and sub-wallet.
    function test_buy_feeOnSink_flushSplitsTreasuryAndDestination() public {
        (address asset,, MultiplyFeeSink sink) = _launch(router, "SNK3", keccak256("sink-three"));
        uint256 hubBefore = IERC20(USDG).balanceOf(hub);
        _buy(asset, 2e6);

        uint256 onSink = IERC20(USDG).balanceOf(address(sink));
        assertGt(onSink, 0.050e6, "fee landed on the sink in USDG");
        assertLt(onSink, 0.060e6);
        assertEq(IERC20(USDG).balanceOf(hub), hubBefore, "the policy hub sees nothing");
        assertEq(IERC20(asset).balanceOf(address(sink)), 0, "no coin on the sink");
        (uint256 pendingUsdg, uint256 pendingCoin) = sink.pending();
        assertEq(pendingUsdg, onSink);
        assertEq(pendingCoin, 0);

        // nothing moves before the keeper adopts the coin
        vm.expectRevert(MultiplyFeeSink.DestinationNotSet.selector);
        sink.flush();

        vm.prank(launcher);
        vm.expectRevert(MultiplyFeeSink.NotKeeper.selector);
        sink.setDestination(subWallet);
        vm.prank(keeper);
        vm.expectRevert(MultiplyFeeSink.ZeroAddress.selector);
        sink.setDestination(address(0));
        vm.prank(keeper);
        sink.setDestination(subWallet);
        // once set, the keeper key cannot move it; the router owner can
        vm.prank(keeper);
        vm.expectRevert(MultiplyFeeSink.NotOwner.selector);
        sink.setDestination(makeAddr("elsewhere"));
        vm.prank(launcher);
        vm.expectRevert(MultiplyFeeSink.NotOwner.selector);
        sink.setDestination(makeAddr("elsewhere"));
        assertEq(sink.destination(), subWallet);

        vm.prank(trader); // anyone
        (uint256 toTreasury, uint256 toDestination, uint256 burned) = sink.flush();
        assertEq(toTreasury, onSink * 1500 / 9500, "15/95 of receipts = 15% of the trading fee");
        assertEq(toDestination, onSink - toTreasury, "the rest = 80% of the trading fee");
        assertEq(burned, 0);
        assertEq(IERC20(USDG).balanceOf(treasury), toTreasury);
        assertEq(IERC20(USDG).balanceOf(subWallet), toDestination);
        assertEq(IERC20(USDG).balanceOf(address(sink)), 0, "sink emptied");
        // sanity on the economics: treasury gets 15/80 of what the engine gets (the floor on the
        // treasury side costs at most one raw unit, i.e. 80 in this product)
        assertApproxEqAbs(toTreasury * 80, toDestination * 15, 80);

        // a second flush with nothing held is a no-op, not a revert
        (toTreasury, toDestination, burned) = sink.flush();
        assertEq(toTreasury + toDestination + burned, 0);
    }

    /// The recovery path: a sub-wallet that became unusable is replaced by the router owner, and
    /// the next flush goes to the new one. Nobody else can do it, and the owner cannot do the
    /// first set (that is the keeper's, so adoption stays automated).
    function test_destination_ownerCanMoveItLater() public {
        (address asset,, MultiplyFeeSink sink) = _launch(router, "SNK9", keccak256("sink-nine"));
        vm.prank(owner);
        vm.expectRevert(MultiplyFeeSink.NotKeeper.selector);
        sink.setDestination(subWallet); // first set is the keeper's job
        vm.prank(keeper);
        sink.setDestination(subWallet);
        _buy(asset, 2e6);
        address subWallet2 = makeAddr("subWallet2");
        vm.prank(owner);
        sink.setDestination(subWallet2);
        assertEq(sink.destination(), subWallet2);
        (, uint256 toDestination,) = sink.flush();
        assertGt(toDestination, 0);
        assertEq(IERC20(USDG).balanceOf(subWallet2), toDestination, "fees follow the new destination");
        assertEq(IERC20(USDG).balanceOf(subWallet), 0);
        // ownership transfer (to a Safe) moves the power with it
        address safe = makeAddr("safe");
        vm.prank(owner);
        router.transferOwnership(safe);
        vm.prank(safe);
        router.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(MultiplyFeeSink.NotOwner.selector);
        sink.setDestination(subWallet);
        vm.prank(safe);
        sink.setDestination(subWallet);
        assertEq(sink.destination(), subWallet);
    }

    /// A recipient that cannot take USDG (frozen, or a contract that rejects) must not lock the
    /// other leg: its share waits in the sink, the rest moves, and a later flush completes it.
    function test_flush_legsAreIndependent() public {
        (address asset,, MultiplyFeeSink sink) = _launch(router, "SNK8", keccak256("sink-eight"));
        _buy(asset, 2e6);
        vm.prank(keeper);
        sink.setDestination(subWallet);
        uint256 held = IERC20(USDG).balanceOf(address(sink));
        uint256 treasuryShare = held * TREASURY_BPS / 9500;
        uint256 destShare = held - treasuryShare;

        // the destination is unusable for now
        vm.mockCallRevert(USDG, abi.encodeCall(IERC20.transfer, (subWallet, destShare)), "frozen");
        (uint256 toTreasury, uint256 toDestination,) = sink.flush();
        assertEq(toTreasury, treasuryShare, "treasury paid anyway");
        assertEq(toDestination, 0, "destination leg skipped, not reverted");
        assertEq(IERC20(USDG).balanceOf(address(sink)), destShare, "the engine's share waits in the sink");
        assertEq(IERC20(USDG).balanceOf(treasury), treasuryShare);
        vm.clearMockedCalls();

        // once it can receive again, the next flush moves the rest (nothing new for the treasury)
        (toTreasury, toDestination,) = sink.flush();
        assertEq(toDestination + toTreasury, destShare, "everything left goes out");
        assertEq(IERC20(USDG).balanceOf(address(sink)), 0);
        // a treasury that cannot receive does not block the destination either
        _buy(asset, 1e6);
        uint256 held2 = IERC20(USDG).balanceOf(address(sink));
        uint256 t2 = held2 * TREASURY_BPS / 9500;
        vm.mockCall(USDG, abi.encodeCall(IERC20.transfer, (treasury, t2)), abi.encode(false));
        (toTreasury, toDestination,) = sink.flush();
        assertEq(toTreasury, 0, "a `false` return counts as not paid");
        assertEq(toDestination, held2 - t2, "destination paid");
        assertEq(IERC20(USDG).balanceOf(address(sink)), t2, "treasury share kept for later");
        vm.clearMockedCalls();
    }

    /// Coins that reach the sink (the hook's fallback when its internal swap cannot run, or
    /// anyone sending them) are burned on flush: supply goes down for real.
    function test_flush_burnsCoinHeld() public {
        (address asset,, MultiplyFeeSink sink) = _launch(router, "SNK4", keccak256("sink-four"));
        uint256 coins = _buy(asset, 1e6);
        vm.prank(trader);
        IERC20(asset).transfer(address(sink), coins);
        vm.prank(keeper);
        sink.setDestination(subWallet);

        uint256 supplyBefore = IERC20(asset).totalSupply();
        (,, uint256 burned) = sink.flush();
        assertEq(burned, coins, "everything held was burned");
        assertEq(IERC20(asset).totalSupply(), supplyBefore - coins, "totalSupply fell by the burn");
        assertEq(IERC20(asset).balanceOf(address(sink)), 0);
    }

    function test_sweep_onlyKeeper_neverNumeraireOrCoin() public {
        (address assetA,, MultiplyFeeSink sinkA) = _launch(router, "SNKA", keccak256("sink-a"));
        (address assetB,,) = _launch(router, "SNKB", keccak256("sink-b"));
        // a foreign token (another launch's coin) lands on sink A by mistake
        uint256 coinsB = _buy(assetB, 1e6);
        vm.prank(trader);
        IERC20(assetB).transfer(address(sinkA), coinsB);
        _buy(assetA, 1e6); // some USDG on sink A too

        vm.prank(launcher);
        vm.expectRevert(MultiplyFeeSink.NotKeeper.selector);
        sinkA.sweep(assetB, keeper);
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MultiplyFeeSink.CannotSweep.selector, USDG));
        sinkA.sweep(USDG, keeper);
        vm.expectRevert(abi.encodeWithSelector(MultiplyFeeSink.CannotSweep.selector, assetA));
        sinkA.sweep(assetA, keeper);
        vm.expectRevert(MultiplyFeeSink.ZeroAddress.selector);
        sinkA.sweep(assetB, address(0));
        uint256 swept = sinkA.sweep(assetB, keeper);
        vm.stopPrank();
        assertEq(swept, coinsB);
        assertEq(IERC20(assetB).balanceOf(keeper), coinsB, "foreign token recovered");
        assertGt(IERC20(USDG).balanceOf(address(sinkA)), 0, "the fee stayed where it was");
    }

    /// The sink exposes no way to call the hook's `setFeeDistribution`, and nobody else may.
    function test_feeMatrix_isImmutable() public {
        (,bytes32 poolId, MultiplyFeeSink sink) = _launch(router, "SNK5", keccak256("sink-five"));
        (,, address dst) = IRehypePoolInfo(REHYPE).getPoolInfo(poolId);
        assertEq(dst, address(sink));
        address[3] memory callers = [keeper, owner, launcher];
        for (uint256 i; i < 3; i++) {
            vm.prank(callers[i]);
            vm.expectRevert();
            IRehypePoolInfo(REHYPE).setFeeDistribution(poolId, 0, 1e18, 0, 0, 0, 1e18, 0, 0);
        }
    }

    function test_firstBuy_throughBundler_sinkBoundAfterwards() public {
        uint128 buy = 3e6;
        bytes32 salt = keccak256("sink-six");
        address predicted = router.predictSink(DEPLOYER, salt);
        vm.startPrank(DEPLOYER);
        IERC20(USDG).approve(address(router), buy);
        (address asset, bytes32 poolId, uint128 out) = router.launch(_input("Dev Sink", "DSNK", 30_000, buy, salt));
        vm.stopPrank();
        assertGt(out, 0);
        MultiplyFeeSink sink = MultiplyFeeSink(router.sinkOf(asset));
        assertEq(address(sink), predicted);
        assertEq(sink.asset(), asset);
        (,, address dst) = IRehypePoolInfo(REHYPE).getPoolInfo(poolId);
        assertEq(dst, address(sink));
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "router holds nothing");
        // the exempt first buy left no non-protocol fee anywhere
        assertEq(IERC20(USDG).balanceOf(address(sink)), 0);
    }

    function test_withoutSinkConfig_feesGoToPolicyHub() public {
        MultiplyLaunchRouter bare = _freshRouter(); // no setSinkConfig
        assertEq(bare.predictSink(launcher, keccak256("x")), address(0));
        vm.prank(launcher);
        (address asset, bytes32 poolId,) = bare.launch(_input("Hub Only", "HUBO", 30_000, 0, keccak256("hub-only")));
        assertEq(bare.sinkOf(asset), address(0), "no sink");
        (,, address dst) = IRehypePoolInfo(REHYPE).getPoolInfo(poolId);
        assertEq(dst, hub, "the policy hub, as before the upgrade");
    }

    function test_setSinkConfig_validation() public {
        MultiplyLaunchRouter.SinkConfig memory c = _config(address(sinkImpl));
        vm.prank(launcher);
        vm.expectRevert();
        router.setSinkConfig(c);

        vm.startPrank(owner);
        c.keeper = address(0);
        vm.expectRevert(MultiplyLaunchRouter.ZeroAddress.selector);
        router.setSinkConfig(c);

        c = _config(address(sinkImpl));
        c.treasuryBps = 9501; // more than the sink can ever receive
        vm.expectRevert(MultiplyLaunchRouter.InvalidSinkConfig.selector);
        router.setSinkConfig(c);

        c = _config(address(new MultiplyFeeSink(makeAddr("another router"))));
        vm.expectRevert(MultiplyLaunchRouter.InvalidSinkConfig.selector);
        router.setSinkConfig(c);

        c = _config(makeAddr("no code"));
        vm.expectRevert(MultiplyLaunchRouter.InvalidSinkConfig.selector);
        router.setSinkConfig(c);
        vm.stopPrank();

        // reading the live config
        MultiplyLaunchRouter.SinkConfig memory live = router.sinkConfig();
        assertEq(live.implementation, address(sinkImpl));
        assertEq(router.keeper(), keeper);
        assertEq(router.treasury(), treasury);
    }

    /// Rotating the keeper or moving the treasury on the router is picked up by existing sinks.
    function test_keeperAndTreasury_readLiveFromRouter() public {
        (address asset,, MultiplyFeeSink sink) = _launch(router, "SNK7", keccak256("sink-seven"));
        _buy(asset, 1e6);
        address keeper2 = makeAddr("keeper2");
        address treasury2 = makeAddr("treasury2");
        MultiplyLaunchRouter.SinkConfig memory c = _config(address(sinkImpl));
        c.keeper = keeper2;
        c.treasury = treasury2;
        vm.prank(owner);
        router.setSinkConfig(c);

        vm.prank(keeper);
        vm.expectRevert(MultiplyFeeSink.NotKeeper.selector);
        sink.setDestination(subWallet);
        vm.prank(keeper2);
        sink.setDestination(subWallet);
        (uint256 toTreasury,,) = sink.flush();
        assertGt(toTreasury, 0);
        assertEq(IERC20(USDG).balanceOf(treasury2), toTreasury, "new treasury paid");
        assertEq(IERC20(USDG).balanceOf(treasury), 0);
    }

    /// The real thing: upgrade the proxy live on Robinhood Chain (pranked as its owner), enable
    /// sinks in the same call, and launch through it.
    function test_liveProxy_upgradeToAndCall_enablesSinks() public {
        MultiplyLaunchRouter live = MultiplyLaunchRouter(LIVE_ROUTER);
        address liveOwner = live.owner();
        MultiplyLaunchRouter.Policy memory before = live.policy();
        MultiplyLaunchRouter.Modules memory modulesBefore = live.modules();

        MultiplyFeeSink liveSinkImpl = new MultiplyFeeSink(LIVE_ROUTER);
        MultiplyLaunchRouter newImpl = new MultiplyLaunchRouter();
        MultiplyLaunchRouter.SinkConfig memory c = MultiplyLaunchRouter.SinkConfig({
            implementation: address(liveSinkImpl),
            keeper: keeper,
            treasury: treasury,
            treasuryBps: TREASURY_BPS
        });
        vm.prank(liveOwner);
        IUUPS(LIVE_ROUTER).upgradeToAndCall(address(newImpl), abi.encodeCall(MultiplyLaunchRouter.setSinkConfig, (c)));

        // storage survived: policy and modules untouched, sink config live
        MultiplyLaunchRouter.Policy memory after_ = live.policy();
        assertEq(after_.feeHub, before.feeHub);
        assertEq(after_.defaultMcap, before.defaultMcap);
        assertEq(after_.maxFee, before.maxFee);
        assertEq(live.modules().rehype, modulesBefore.rehype);
        assertEq(live.owner(), liveOwner);
        assertEq(live.sinkConfig().implementation, address(liveSinkImpl));
        assertEq(live.keeper(), keeper);
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        live.initialize(liveOwner, modulesBefore, before);

        // a launch through the upgraded live proxy gets a sink, and the fee reaches it
        (address asset, bytes32 poolId, MultiplyFeeSink sink) = _launch(live, "LIVE", keccak256("live-sink"));
        (,, address dst) = IRehypePoolInfo(REHYPE).getPoolInfo(poolId);
        assertEq(dst, address(sink));
        uint256 hubBefore = IERC20(USDG).balanceOf(before.feeHub);
        _buy(asset, 2e6);
        assertGt(IERC20(USDG).balanceOf(address(sink)), 0.050e6, "fee on the sink");
        assertEq(IERC20(USDG).balanceOf(before.feeHub), hubBefore, "the old hub gets nothing");
    }
}
