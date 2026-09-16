// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {MultiplyLaunchRouter} from "../src/MultiplyLaunchRouter.sol";
import {MultiplyFeeSink} from "../src/MultiplyFeeSink.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/**
 * Upgrades the live MultiplyLaunchRouter proxy to the sink-enabled implementation and turns
 * per-coin fee sinks on, in ONE transaction (`upgradeToAndCall`): there is no block in which the
 * new code runs without a sink config.
 *
 * Must be sent by the router owner. Required env, no silent defaults:
 *   ROUTER         the proxy (0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd on Robinhood Chain)
 *   SINK_KEEPER    address allowed to set each sink's destination and sweep stray tokens
 *   SINK_TREASURY  receives the protocol share of every flush
 *   TREASURY_BPS   protocol share in bps of the whole trading fee (1500 = 15%, engine gets 80%)
 *
 *   forge script script/UpgradeRouterSink.s.sol --rpc-url $ROBINHOOD_RPC_URL \
 *     --sender <owner> --private-key $DEPLOYER_PRIVATE_KEY [--broadcast]
 */
contract UpgradeRouterSink is Script {
    struct Config {
        address router;
        address keeper;
        address treasury;
        uint16 treasuryBps;
    }

    function run() external returns (address sinkImpl, address routerImpl) {
        Config memory cfg = Config({
            router: vm.envAddress("ROUTER"),
            keeper: vm.envAddress("SINK_KEEPER"),
            treasury: vm.envAddress("SINK_TREASURY"),
            treasuryBps: uint16(vm.envUint("TREASURY_BPS"))
        });
        MultiplyLaunchRouter r = MultiplyLaunchRouter(cfg.router);
        require(r.owner() == msg.sender, "sender is not the router owner");
        if (cfg.keeper == msg.sender) console.log("NOTE: the sink keeper is the sender key");
        vm.startBroadcast();
        (sinkImpl, routerImpl) = upgrade(cfg);
        vm.stopBroadcast();
        console.log("router proxy:", cfg.router);
        console.log("new router implementation:", routerImpl);
        console.log("sink implementation:", sinkImpl);
        console.log("keeper:", cfg.keeper);
        console.log("treasury:", cfg.treasury);
        console.log("treasury bps of the trading fee:", cfg.treasuryBps);
    }

    function upgrade(Config memory cfg) public returns (address sinkImpl, address routerImpl) {
        MultiplyLaunchRouter r = MultiplyLaunchRouter(cfg.router);
        MultiplyLaunchRouter.Policy memory policyBefore = r.policy();
        address ownerBefore = r.owner();

        sinkImpl = address(new MultiplyFeeSink(cfg.router));
        routerImpl = address(new MultiplyLaunchRouter());
        MultiplyLaunchRouter.SinkConfig memory sink = MultiplyLaunchRouter.SinkConfig({
            implementation: sinkImpl,
            keeper: cfg.keeper,
            treasury: cfg.treasury,
            treasuryBps: cfg.treasuryBps
        });
        IUUPS(cfg.router).upgradeToAndCall(routerImpl, abi.encodeCall(MultiplyLaunchRouter.setSinkConfig, (sink)));

        // read back: nothing that was there may have moved, and the sink must be live
        require(r.owner() == ownerBefore, "owner changed");
        MultiplyLaunchRouter.Policy memory p = r.policy();
        require(
            p.feeHub == policyBefore.feeHub && p.numeraire == policyBefore.numeraire
                && p.defaultMcap == policyBefore.defaultMcap && p.maxFee == policyBefore.maxFee,
            "policy changed"
        );
        MultiplyLaunchRouter.SinkConfig memory s = r.sinkConfig();
        require(s.implementation == sinkImpl && s.keeper == cfg.keeper && s.treasury == cfg.treasury, "sink config mismatch");
        require(s.treasuryBps == cfg.treasuryBps, "treasury bps mismatch");
        require(MultiplyFeeSink(sinkImpl).ROUTER() == cfg.router, "sink bound to another router");
    }
}
