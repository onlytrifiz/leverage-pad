// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MultiplyLaunchRouter} from "../src/MultiplyLaunchRouter.sol";

/**
 * Upgrades the live MultiplyLaunchRouter proxy to the managed-market implementation: a managed
 * coin's creator may change market and side too, and the notice is set to MANAGED_DELAY in the
 * same transaction. Besides the deploy (and the DopplerLaunch library forge links by itself) it is
 * ONE owner transaction. Coins already launched keep their engine, sink and window.
 *
 * Deploy the matching keeper FIRST: it must read `pendingMarket`/`market` changes before anyone
 * can announce one. Until this runs it keeps the engines it has recorded.
 *
 * Must be sent by the router owner. Required env, no silent defaults:
 *   ROUTER         the proxy (0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd on Robinhood Chain)
 *   MANAGED_DELAY  seconds between an announcement and its effect (3600 = 1 hour)
 *
 *   forge script script/UpgradeRouterManaged.s.sol --rpc-url $ROBINHOOD_RPC_URL \
 *     --sender <owner> --private-key $DEPLOYER_PRIVATE_KEY [--broadcast --slow]
 *
 * Stop the keeper while this runs when the owner key is also the keeper's (nonces). The checks at
 * the end run in simulation only: re-read the live proxy after the broadcast.
 */
contract UpgradeRouterManaged is Script {
    function run() external returns (address routerImpl) {
        address router = vm.envAddress("ROUTER");
        uint32 delay = SafeCast.toUint32(vm.envUint("MANAGED_DELAY"));
        require(MultiplyLaunchRouter(router).owner() == msg.sender, "sender is not the router owner");
        vm.startBroadcast();
        routerImpl = upgrade(router, delay);
        vm.stopBroadcast();
        console.log("router proxy:", router);
        console.log("new router implementation:", routerImpl);
        console.log("managed delay (seconds):", delay);
    }

    function upgrade(address router, uint32 delay) public returns (address routerImpl) {
        MultiplyLaunchRouter r = MultiplyLaunchRouter(router);
        MultiplyLaunchRouter.EngineConfig memory c = r.engineConfig();
        bytes32 policyBefore = keccak256(abi.encode(r.policy()));
        bytes32 sinkBefore = keccak256(abi.encode(r.sinkConfig()));
        bytes32 modulesBefore = keccak256(abi.encode(r.modules()));
        address ownerBefore = r.owner();

        c.managedDelay = delay;
        routerImpl = address(new MultiplyLaunchRouter());
        r.upgradeToAndCall(routerImpl, abi.encodeCall(MultiplyLaunchRouter.setEngineConfig, (c)));

        // read back: only the delay may have moved
        require(r.owner() == ownerBefore, "owner changed");
        require(keccak256(abi.encode(r.engineConfig())) == keccak256(abi.encode(c)), "engine config mismatch");
        require(keccak256(abi.encode(r.policy())) == policyBefore, "policy changed");
        require(keccak256(abi.encode(r.sinkConfig())) == sinkBefore, "sink config changed");
        require(keccak256(abi.encode(r.modules())) == modulesBefore, "modules changed");
    }
}
