// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MultiplyLaunchRouter} from "../src/MultiplyLaunchRouter.sol";

interface IPoolManagerView {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IInitializerView {
    struct Ben {
        address beneficiary;
        uint96 shares;
    }

    function getBeneficiaries(address asset) external view returns (Ben[] memory);
}

interface IStateView {
    // PoolState: numeraire, beneficiaries[], adjustedCurves[], totalTokensOnBondingCurve, dopplerHook, grad calldata, status, poolKey, farTick
    // reading the struct through the auto-getter is awkward; expose only what the tests need via getState-free checks
}

interface IERC20Meta {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI() external view returns (string memory);
}

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

interface IRehypeView {
    function getHookFees(bytes32 poolId)
        external
        view
        returns (uint128 fees0, uint128 fees1, uint128 b0, uint128 b1, uint128 airlock0, uint128 airlock1);
    function getFeeSchedule(bytes32 poolId)
        external
        view
        returns (uint32 startingTime, uint24 startFee, uint24 endFee, uint24 lastFee, uint32 durationSeconds);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerSwap {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// Minimal v4 swapper for tests: exact-in, no price limit, settles in and takes out.
contract Swapper {
    IPoolManagerSwap immutable pm;

    constructor(address pm_) {
        pm = IPoolManagerSwap(pm_);
    }

    function swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) external returns (uint256 amountOut) {
        bytes memory r = pm.unlock(abi.encode(key, zeroForOne, amountIn, msg.sender));
        return abi.decode(r, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address to) =
            abi.decode(data, (PoolKey, bool, uint256, address));
        int256 delta = pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            ""
        );
        // BalanceDelta packs amount0 (high 128) and amount1 (low 128)
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        (address cin, address cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        int128 din = zeroForOne ? a0 : a1;
        int128 dout = zeroForOne ? a1 : a0;
        pm.sync(cin);
        IERC20(cin).transfer(address(pm), uint256(uint128(-din)));
        pm.settle();
        uint256 amountOut = uint256(uint128(dout));
        pm.take(cout, to, amountOut);
        return abi.encode(amountOut);
    }
}

/// Fork tests against Doppler's live Robinhood Chain deployment:
///   FOUNDRY_PROFILE=fork forge test --match-contract MultiplyLaunchRouterFork -vv   (ROBINHOOD_RPC_URL set)
contract MultiplyLaunchRouterFork is Test {
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
    uint24 constant DYNAMIC = 0x800000;

    MultiplyLaunchRouter router;
    Swapper swapper;
    address owner = makeAddr("owner");
    address launcher = makeAddr("launcher");
    address hub = makeAddr("hub");
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(vm.envString("ROBINHOOD_RPC_URL"));
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
        router = MultiplyLaunchRouter(address(new ERC1967Proxy(address(impl), init)));
        swapper = new Swapper(POOL_MANAGER);
        vm.deal(launcher, 1 ether);
        // fund the trader with real USDG from the deployer
        vm.prank(DEPLOYER);
        IERC20(USDG).transfer(trader, 5e6);
    }

    function _slot0(bytes32 poolId) internal view returns (int24 tick, uint24 lpFee) {
        bytes32 base = keccak256(abi.encode(poolId, uint256(6)));
        uint256 s0 = uint256(IPoolManagerView(POOL_MANAGER).extsload(base));
        tick = int24(int256((s0 >> 160) & 0xffffff));
        lpFee = uint24((s0 >> 208) & 0xffffff);
    }

    function _key(address asset) internal pure returns (PoolKey memory) {
        (address c0, address c1) = asset < USDG ? (asset, USDG) : (USDG, asset);
        return PoolKey({currency0: c0, currency1: c1, fee: DYNAMIC, tickSpacing: 200, hooks: INITIALIZER});
    }

    function _input(string memory name, string memory symbol, uint24 fee, bool antiSnipe, uint256 mcap, uint128 firstBuy, bytes32 salt)
        internal
        pure
        returns (MultiplyLaunchRouter.LaunchInput memory)
    {
        return MultiplyLaunchRouter.LaunchInput({
            name: name,
            symbol: symbol,
            tokenURI: "ipfs://bafkreiazkosvsyrp24xbvqeoyihoxbidgbt24ih24ter26lj5mez36amw4",
            fee: fee,
            antiSnipe: antiSnipe,
            mcap: mcap,
            firstBuy: firstBuy,
            salt: salt,
            market: "NVDA",
            side: 0,
            leverage: 3,
            risk: 1
        });
    }

    function test_tickForMcap_matchesOffchainPlan() public view {
        (int24 tick, int24 maxTick) = router.tickForMcap(4_000e6);
        assertEq(tick, -400600, "tick for $4k");
        assertEq(maxTick, 887200, "top of ladder");
    }

    function test_launch_default_locked_zeroLpFee_flatHookFee() public {
        vm.prank(launcher);
        (address asset, bytes32 poolId,) = router.launch(_input("Router Test", "RTEST", 30_000, false, 0, 0, keccak256("one")));
        assertGt(asset.code.length, 0, "token deployed");
        assertApproxEqAbs(IERC20(asset).balanceOf(POOL_MANAGER), 1e27, 1e12, "all supply in the pool");
        (int24 tick, uint24 lpFee) = _slot0(poolId);
        assertEq(asset < USDG ? tick : -tick, -400600, "opens at $4k");
        assertEq(lpFee, 0, "no LP fee: the hook takes it");
        (, uint24 startFee, uint24 endFee,, uint32 dur) = IRehypeView(REHYPE).getFeeSchedule(poolId);
        assertEq(startFee, 30_000, "flat");
        assertEq(endFee, 30_000, "3%");
        assertEq(dur, 0, "no decay");
        IInitializerView.Ben[] memory bens = IInitializerView(INITIALIZER).getBeneficiaries(asset);
        assertEq(bens.length, 2, "locked with hub + Doppler");
        for (uint256 i; i < 2; i++) {
            if (bens[i].beneficiary == hub) assertEq(bens[i].shares, 0.95e18, "hub 95%");
            else {
                assertEq(bens[i].beneficiary, DOPPLER_SAFE, "the other beneficiary is Doppler");
                assertEq(bens[i].shares, 0.05e18, "Doppler 5%");
            }
        }
        assertEq(IERC20Meta(asset).name(), "Router Test");
        assertEq(IERC20Meta(asset).symbol(), "RTEST");
        assertEq(IERC20Meta(asset).tokenURI(), "ipfs://bafkreiazkosvsyrp24xbvqeoyihoxbidgbt24ih24ter26lj5mez36amw4");
    }

    function test_launch_antiSnipe_schedule() public {
        vm.prank(launcher);
        (, bytes32 poolId,) = router.launch(_input("Protected", "PROT", 20_000, true, 0, 0, keccak256("two")));
        (, uint24 startFee, uint24 endFee,, uint32 dur) = IRehypeView(REHYPE).getFeeSchedule(poolId);
        assertEq(startFee, 800_000, "80% at open");
        assertEq(endFee, 20_000, "decays to 2%");
        assertEq(dur, 10, "over 10s");
    }

    /// The point of the design: a buy pays its fee in the coin, the hook swaps it to USDG in the
    /// same call, and the hub only ever sees USDG.
    function test_buy_feeArrivesInNumeraireOnly() public {
        vm.prank(launcher);
        (address asset, bytes32 poolId,) = router.launch(_input("Quote Fee", "QFEE", 30_000, false, 0, 0, keccak256("three")));
        PoolKey memory key = _key(asset);
        bool usdgIs0 = USDG < asset;

        uint256 hubUsdgBefore = IERC20(USDG).balanceOf(hub);
        vm.startPrank(trader);
        IERC20(USDG).transfer(address(swapper), 2e6);
        uint256 out = swapper.swap(key, usdgIs0, 2e6); // buy: USDG in
        vm.stopPrank();
        assertGt(out, 0, "bought");
        assertEq(IERC20(asset).balanceOf(trader), out, "coins to the trader");

        uint256 hubGain = IERC20(USDG).balanceOf(hub) - hubUsdgBefore;
        // 3% of the output in coin, swapped back into USDG (≈ 3% of the 2 USDG spent, minus the
        // swap's own tiny impact), minus Doppler's 5% slice which is kept in the coin
        assertGt(hubGain, 0.050e6, "fee landed in USDG on the hub");
        assertLt(hubGain, 0.060e6, "not more than the fee");
        assertEq(IERC20(asset).balanceOf(hub), 0, "hub never holds the coin");
        (uint128 f0, uint128 f1, uint128 b0, uint128 b1, uint128 a0, uint128 a1) = IRehypeView(REHYPE).getHookFees(poolId);
        assertEq(uint256(f0) + f1, 0, "nothing left pending on the hook");
        assertEq(uint256(b0) + b1, 0, "no coin parked as beneficiary fees");
        assertGt(uint256(a0) + a1, 0, "Doppler's 5% slice accrued");
    }

    /// Inside the protection window the fee is high and decays linearly; after it, the flat fee.
    function test_buy_duringProtection_thenAfter() public {
        vm.prank(launcher);
        (address asset, bytes32 poolId,) = router.launch(_input("Protected", "PROT", 30_000, true, 0, 0, keccak256("nine")));
        PoolKey memory key = _key(asset);
        bool usdgIs0 = USDG < asset;
        vm.warp(block.timestamp + 5); // halfway: 80% → 3% linear ⇒ ~41.5%
        vm.startPrank(trader);
        IERC20(USDG).transfer(address(swapper), 1e6);
        uint256 outEarly = swapper.swap(key, usdgIs0, 1e6);
        vm.warp(block.timestamp + 60);
        IERC20(USDG).transfer(address(swapper), 1e6);
        uint256 outLate = swapper.swap(key, usdgIs0, 1e6);
        vm.stopPrank();
        // the late buy is at a slightly higher price yet gets far more tokens: the early fee bit hard
        assertGt(outLate, outEarly * 15 / 10, "protection fee visibly larger than the flat fee");
        (, uint24 startFee, uint24 endFee, uint24 lastFee,) = IRehypeView(REHYPE).getFeeSchedule(poolId);
        assertEq(startFee, 800_000);
        assertEq(endFee, 30_000);
        assertEq(lastFee, 30_000, "fully decayed");
    }

    function test_firstBuy_withProtection_paysDopplerSliceOfOpeningFee() public {
        uint128 buy = 2e6;
        vm.startPrank(DEPLOYER);
        IERC20(USDG).approve(address(router), buy);
        (address asset, bytes32 poolId, uint128 out) =
            router.launch(_input("Dev Prot", "DEVP", 30_000, true, 0, buy, keccak256("ten")));
        vm.stopPrank();
        (uint128 f0, uint128 f1,,, uint128 a0, uint128 a1) = IRehypeView(REHYPE).getHookFees(poolId);
        assertEq(uint256(f0) + f1, 0, "non-protocol part waived");
        uint256 gross = out + a0 + a1;
        // 5% of the 80% opening fee = 4% of gross output
        assertApproxEqRel(uint256(a0) + a1, gross * 4 / 100, 1e15, "Doppler slice = 4% with protection on");
        assertEq(IERC20(asset).balanceOf(DEPLOYER), out);
    }

    function test_salt_isNamespacedPerLauncher() public {
        bytes32 salt = keccak256("shared");
        vm.prank(launcher);
        (address a1,,) = router.launch(_input("A", "AAA", 10_000, false, 0, 0, salt));
        address other = makeAddr("other");
        vm.prank(other);
        (address a2,,) = router.launch(_input("B", "BBB", 10_000, false, 0, 0, salt));
        assertTrue(a1 != a2, "same salt, two launchers, two tokens");
        vm.prank(launcher);
        vm.expectRevert();
        router.launch(_input("A", "AAA", 10_000, false, 0, 0, salt)); // same launcher, same salt: clone exists
    }

    function test_admin_onlyOwner_and_validation() public {
        MultiplyLaunchRouter.Policy memory p = router.policy();
        vm.prank(launcher);
        vm.expectRevert();
        router.setPolicy(p);
        p.maxFee = 900_000; // above Rehype's cap
        vm.prank(owner);
        vm.expectRevert(MultiplyLaunchRouter.InvalidPolicy.selector);
        router.setPolicy(p);
        p = router.policy();
        p.protocolShareWad = 0.01e18; // below Doppler's minimum
        vm.prank(owner);
        vm.expectRevert(MultiplyLaunchRouter.InvalidPolicy.selector);
        router.setPolicy(p);
        MultiplyLaunchRouter.Modules memory m = router.modules();
        m.rehype = address(0xBEEF);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MultiplyLaunchRouter.RehypeNotEnabled.selector, address(0xBEEF)));
        router.setModules(m);
        m = router.modules();
        m.tokenFactory = NOOP_GOV; // whitelisted, but as the wrong module type
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MultiplyLaunchRouter.ModuleNotWhitelisted.selector, NOOP_GOV, uint8(1)));
        router.setModules(m);
    }

    function test_upgrade_onlyOwner_and_reinit_blocked() public {
        MultiplyLaunchRouter impl2 = new MultiplyLaunchRouter();
        vm.prank(launcher);
        vm.expectRevert();
        IUUPS(address(router)).upgradeToAndCall(address(impl2), "");
        vm.prank(owner);
        IUUPS(address(router)).upgradeToAndCall(address(impl2), "");
        assertEq(router.policy().defaultMcap, 4_000e6, "storage survives the upgrade");
        MultiplyLaunchRouter.Modules memory m = router.modules();
        MultiplyLaunchRouter.Policy memory p = router.policy();
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        router.initialize(owner, m, p);
    }

    /// A sell pays its fee in USDG already. The hook flushes to the hub once the pending USDG
    /// side exceeds its EPSILON (1e6 raw = 1 USDG); below that the fee waits on the hook, so the
    /// sum of what the hub got and what is pending must equal the fee.
    function test_sell_feeArrivesInNumeraire() public {
        vm.prank(launcher);
        (address asset, bytes32 poolId,) = router.launch(_input("Sell Fee", "SFEE", 30_000, false, 0, 0, keccak256("four")));
        PoolKey memory key = _key(asset);
        bool usdgIs0 = USDG < asset;
        vm.startPrank(trader);
        IERC20(USDG).transfer(address(swapper), 3e6);
        uint256 coins = swapper.swap(key, usdgIs0, 3e6);
        uint256 hubBefore = IERC20(USDG).balanceOf(hub);
        (uint128 pf0, uint128 pf1,,,,) = IRehypeView(REHYPE).getHookFees(poolId);
        uint256 pendingBefore = usdgIs0 ? pf0 : pf1;
        IERC20(asset).transfer(address(swapper), coins);
        uint256 usdgOut = swapper.swap(key, !usdgIs0, coins); // sell: coin in
        vm.stopPrank();
        assertGt(usdgOut, 0, "sold");
        (uint128 f0, uint128 f1,,,,) = IRehypeView(REHYPE).getHookFees(poolId);
        uint256 pending = (usdgIs0 ? f0 : f1) - pendingBefore;
        uint256 hubGain = IERC20(USDG).balanceOf(hub) - hubBefore;
        // fee = 3% of gross output, of which 95% is non-protocol; Doppler's 5% is accounted separately
        uint256 gross = usdgOut * 1_000_000 / 970_000;
        assertApproxEqRel(hubGain + pending, gross * 3 / 100 * 95 / 100, 2e16, "sell fee in USDG, on the hub or pending");
        assertEq(IERC20(asset).balanceOf(hub), 0, "hub never holds the coin");
    }

    function test_launch_withFirstBuy_devExemption_flatFee() public {
        uint128 buy = 3e6;
        vm.startPrank(DEPLOYER);
        IERC20(USDG).approve(address(router), buy);
        (address asset, bytes32 poolId, uint128 out) =
            router.launch(_input("Dev Buy", "DEVB", 30_000, false, 0, buy, keccak256("five")));
        vm.stopPrank();
        assertGt(out, 0, "first buy filled");
        assertEq(IERC20(asset).balanceOf(DEPLOYER), out, "bought tokens to the launcher");
        (uint128 f0, uint128 f1,,, uint128 a0, uint128 a1) = IRehypeView(REHYPE).getHookFees(poolId);
        assertEq(uint256(f0) + f1, 0, "non-protocol fee waived on the dev buy");
        // flat 3% fee: Doppler's slice is 5% of 3% = 0.15% of gross output
        uint256 gross = out + a0 + a1;
        assertApproxEqRel(uint256(a0) + a1, gross * 15 / 10_000, 1e15, "Doppler slice = 0.15% of gross");
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "router holds nothing");
    }

    /// The engine is on-chain: validated in the keeper's ranges and emitted for it to read.
    function test_engine_validatedAndEmitted() public {
        MultiplyLaunchRouter.LaunchInput memory i = _input("Engine", "ENG", 30_000, false, 0, 0, keccak256("eng"));
        i.market = "TSLA";
        i.side = 1;
        i.leverage = 5;
        i.risk = 2;
        vm.expectEmit(false, false, false, true, address(router));
        emit MultiplyLaunchRouter.MultiplyEngine(address(0), "TSLA", 1, 5, 2);
        vm.prank(launcher);
        router.launch(i);

        assertTrue(router.validEngine("BTC", 0, 2, 0));
        assertTrue(router.validEngine("0G", 1, 20, 1));
        assertFalse(router.validEngine("nvda", 0, 3, 1), "lowercase");
        assertFalse(router.validEngine("NVDA/USDG", 0, 3, 1), "punctuation");
        assertFalse(router.validEngine("X", 0, 3, 1), "too short");
        assertFalse(router.validEngine("ABCDEFGHIJKLM", 0, 3, 1), "too long");
        assertFalse(router.validEngine("NVDA", 2, 3, 1), "side");
        assertFalse(router.validEngine("NVDA", 0, 7, 1), "leverage not in the set");
        assertFalse(router.validEngine("NVDA", 0, 0, 1), "leverage zero");
        assertFalse(router.validEngine("NVDA", 0, 3, 3), "risk");

        vm.startPrank(launcher);
        i.salt = keccak256("eng2");
        i.leverage = 7;
        vm.expectRevert(MultiplyLaunchRouter.InvalidEngine.selector);
        router.launch(i);
        i.leverage = 3;
        i.market = "nvda";
        vm.expectRevert(MultiplyLaunchRouter.InvalidEngine.selector);
        router.launch(i);
        vm.stopPrank();
    }

    function test_feeBounds_and_pause() public {
        vm.startPrank(launcher);
        vm.expectRevert(abi.encodeWithSelector(MultiplyLaunchRouter.FeeOutOfRange.selector, 60_000, 10_000, 50_000));
        router.launch(_input("Bad", "BAD", 60_000, false, 0, 0, keccak256("six")));
        vm.expectRevert(abi.encodeWithSelector(MultiplyLaunchRouter.McapOutOfRange.selector, 500e6, 1_000e6, 100_000e6));
        router.launch(_input("Bad", "BAD", 10_000, false, 500e6, 0, keccak256("seven")));
        vm.stopPrank();
        vm.prank(owner);
        router.pause();
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        router.launch(_input("P", "P", 10_000, false, 0, 0, keccak256("eight")));
    }
}
