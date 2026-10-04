// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {MultiplyLaunchRouter} from "../src/MultiplyLaunchRouter.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/**
 * Upgrades the live MultiplyLaunchRouter proxy to the engine implementation (stored engines,
 * custom take-profit, managed coins, owner override) and sets the engine bounds in ONE
 * transaction: there is no block in which the new code runs without bounds (it would refuse
 * every launch).
 *
 * Must be sent by the router owner. Required env, no silent defaults:
 *   ROUTER                 the proxy (0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd on Robinhood Chain)
 *   LEVERAGES              comma list of allowed stops, e.g. 2,3,5,10,20,25,50
 *   TP_MIN_PCT, TP_MAX_PCT take-profit bounds per deposit, e.g. 10 and 500
 *   MANAGED_DELAY_SECONDS  notice before a managed coin's change takes effect, e.g. 43200 (12 h)
 *
 *   forge script script/UpgradeRouterEngine.s.sol --rpc-url $ROBINHOOD_RPC_URL \
 *     --sender <owner> --private-key $DEPLOYER_PRIVATE_KEY [--broadcast]
 *
 * The launch ABI changes (risk → takeProfitPct + managed): the site and the keeper must ship
 * the matching build right after this transaction.
 */
contract UpgradeRouterEngine is Script {
    struct Config {
        address router;
        uint256[] leverages;
        uint16 tpMin;
        uint16 tpMax;
        uint32 delay;
    }

    function run() external returns (address routerImpl) {
        Config memory cfg = Config({
            router: vm.envAddress("ROUTER"),
            leverages: vm.envUint("LEVERAGES", ","),
            tpMin: uint16(vm.envUint("TP_MIN_PCT")),
            tpMax: uint16(vm.envUint("TP_MAX_PCT")),
            delay: uint32(vm.envUint("MANAGED_DELAY_SECONDS"))
        });
        require(MultiplyLaunchRouter(cfg.router).owner() == msg.sender, "sender is not the router owner");
        vm.startBroadcast();
        routerImpl = upgrade(cfg);
        vm.stopBroadcast();
        MultiplyLaunchRouter.EngineConfig memory e = MultiplyLaunchRouter(cfg.router).engineConfig();
        console.log("router proxy:", cfg.router);
        console.log("new router implementation:", routerImpl);
        console.log("leverage mask:", e.leverageMask);
        console.log("take-profit range (pct):", e.minTakeProfitPct, e.maxTakeProfitPct);
        console.log("managed delay (s):", e.managedDelay);
    }

    function maskOf(uint256[] memory leverages) public pure returns (uint64 mask) {
        for (uint256 i; i < leverages.length; i++) {
            require(leverages[i] >= 2 && leverages[i] < 64, "leverage out of range");
            mask |= uint64(1) << leverages[i];
        }
    }

    function upgrade(Config memory cfg) public returns (address routerImpl) {
        MultiplyLaunchRouter r = MultiplyLaunchRouter(cfg.router);
        MultiplyLaunchRouter.Policy memory policyBefore = r.policy();
        MultiplyLaunchRouter.SinkConfig memory sinkBefore = r.sinkConfig();
        address ownerBefore = r.owner();

        MultiplyLaunchRouter.EngineConfig memory engine = MultiplyLaunchRouter.EngineConfig({
            leverageMask: maskOf(cfg.leverages),
            minTakeProfitPct: cfg.tpMin,
            maxTakeProfitPct: cfg.tpMax,
            managedDelay: cfg.delay
        });
        routerImpl = address(new MultiplyLaunchRouter());
        IUUPS(cfg.router).upgradeToAndCall(routerImpl, abi.encodeCall(MultiplyLaunchRouter.setEngineConfig, (engine)));

        // read back: nothing that was there may have moved, and the bounds must be live
        require(r.owner() == ownerBefore, "owner changed");
        MultiplyLaunchRouter.Policy memory p = r.policy();
        require(
            p.feeHub == policyBefore.feeHub && p.numeraire == policyBefore.numeraire
                && p.defaultMcap == policyBefore.defaultMcap && p.maxFee == policyBefore.maxFee,
            "policy changed"
        );
        MultiplyLaunchRouter.SinkConfig memory s = r.sinkConfig();
        require(
            s.implementation == sinkBefore.implementation && s.keeper == sinkBefore.keeper
                && s.treasury == sinkBefore.treasury && s.treasuryBps == sinkBefore.treasuryBps,
            "sink config changed"
        );
        MultiplyLaunchRouter.EngineConfig memory e = r.engineConfig();
        require(
            e.leverageMask == engine.leverageMask && e.minTakeProfitPct == cfg.tpMin && e.maxTakeProfitPct == cfg.tpMax
                && e.managedDelay == cfg.delay,
            "engine config mismatch"
        );
        require(r.validEngine("BTC", 0, 2, cfg.tpMin), "a minimal engine must validate");
    }
}
