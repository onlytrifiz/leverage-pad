// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {MultiplyLaunchRouter} from "../src/MultiplyLaunchRouter.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MultiplyFeeSink} from "../src/MultiplyFeeSink.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/**
 * Upgrades the live MultiplyLaunchRouter proxy to the launch implementation (protection window
 * chosen per launch, launch buy delivered to several wallets) and moves FUTURE coins to a new sink
 * implementation and protocol share. Two owner transactions besides the deploys, in this order:
 *   1. `upgradeToAndCall(impl, setPolicy)`: the policy's two snipe fields become the maxima in the
 *      same transaction that changes their meaning. From here the old `launch` selector is gone.
 *   2. `setSinkConfig`: new sink implementation and share, same keeper and treasury. Second, so
 *      that nobody who signed the old `launch` can end up with the new, larger protocol share.
 * Coins already launched keep their sink's split, their window and their engine.
 *
 * Must be sent by the router owner. Required env, no silent defaults:
 *   ROUTER             the proxy (0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd on Robinhood Chain)
 *   TREASURY_BPS       protocol share in bps of the whole trading fee (2500 = 25%, engine gets 70%)
 *   SNIPE_MAX_FEE      highest opening fee a launch may ask for, 1e6-based (800000 = 80%)
 *   SNIPE_MAX_SECONDS  longest window a launch may ask for (600 = 10 minutes)
 *
 *   forge script script/UpgradeRouterLaunch.s.sol --rpc-url $ROBINHOOD_RPC_URL \
 *     --sender <owner> --private-key $DEPLOYER_PRIVATE_KEY [--broadcast]
 *
 * Stop the keeper first when the owner key is also the keeper's (nonces), and use --slow. The
 * checks at the end run in simulation only: re-read the live proxy after the broadcast.
 *
 * Forge deploys and links the `DopplerLaunch` library by itself. The launch ABI changes: the site
 * and the CLI must ship the matching build right after this transaction.
 */
contract UpgradeRouterLaunch is Script {
    struct Config {
        address router;
        uint16 treasuryBps;
        uint24 snipeMaxFee;
        uint32 snipeMaxSeconds;
    }

    function run() external returns (address routerImpl) {
        Config memory cfg = Config({
            router: vm.envAddress("ROUTER"),
            treasuryBps: SafeCast.toUint16(vm.envUint("TREASURY_BPS")),
            snipeMaxFee: SafeCast.toUint24(vm.envUint("SNIPE_MAX_FEE")),
            snipeMaxSeconds: SafeCast.toUint32(vm.envUint("SNIPE_MAX_SECONDS"))
        });
        require(MultiplyLaunchRouter(cfg.router).owner() == msg.sender, "sender is not the router owner");
        vm.startBroadcast();
        routerImpl = upgrade(cfg);
        vm.stopBroadcast();
        console.log("router proxy:", cfg.router);
        console.log("new router implementation:", routerImpl);
        console.log("new sink implementation:", MultiplyLaunchRouter(cfg.router).sinkConfig().implementation);
        console.log("protocol share (bps):", cfg.treasuryBps);
        console.log("protection window maxima (fee, seconds):", cfg.snipeMaxFee, cfg.snipeMaxSeconds);
    }

    function upgrade(Config memory cfg) public returns (address routerImpl) {
        MultiplyLaunchRouter r = MultiplyLaunchRouter(cfg.router);
        MultiplyLaunchRouter.Policy memory p = r.policy();
        MultiplyLaunchRouter.SinkConfig memory s = r.sinkConfig();
        bytes32 engineBefore = keccak256(abi.encode(r.engineConfig()));
        bytes32 modulesBefore = keccak256(abi.encode(r.modules()));
        address ownerBefore = r.owner();

        routerImpl = address(new MultiplyLaunchRouter());
        s.implementation = address(new MultiplyFeeSink(cfg.router));
        s.treasuryBps = cfg.treasuryBps;
        p.snipeStartFee = cfg.snipeMaxFee;
        p.snipeSeconds = cfg.snipeMaxSeconds;
        IUUPS(cfg.router).upgradeToAndCall(routerImpl, abi.encodeCall(MultiplyLaunchRouter.setPolicy, (p)));
        r.setSinkConfig(s);

        // read back: only the values above may have moved
        require(r.owner() == ownerBefore, "owner changed");
        require(keccak256(abi.encode(r.policy())) == keccak256(abi.encode(p)), "policy mismatch");
        require(keccak256(abi.encode(r.sinkConfig())) == keccak256(abi.encode(s)), "sink config mismatch");
        require(keccak256(abi.encode(r.engineConfig())) == engineBefore, "engine config changed");
        require(keccak256(abi.encode(r.modules())) == modulesBefore, "modules changed");
    }
}
