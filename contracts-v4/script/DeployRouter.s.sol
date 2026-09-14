// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MultiplyLaunchRouter} from "../src/MultiplyLaunchRouter.sol";

/**
 * Deploys the MultiplyLaunchRouter implementation and its UUPS proxy on Robinhood Chain.
 *
 * `run()` reads the environment, `deploy()` does the work with explicit arguments, so a test can
 * drive it without touching the environment. Pass the critical values on the command line rather
 * than relying on a .env: Foundry auto-loads one silently and `vm.envOr` would take it over the
 * default without saying so.
 *
 *   forge script script/DeployRouter.s.sol --rpc-url $ROBINHOOD_RPC_URL \
 *     --sender <deployer> --private-key $DEPLOYER_PRIVATE_KEY [--broadcast]
 *
 * Required env (no silent defaults): ROUTER_OWNER (UUPS admin + policy owner; a multisig for go-live)
 * and FEE_HUB (receives every fee until the keeper adopts the coin). The script reads the policy and
 * owner back after deploying and reverts if they differ from what was asked.
 */
contract DeployRouter is Script {
    // Doppler's official Robinhood Chain deployment (docs.doppler.lol/reference/contract-addresses)
    address constant AIRLOCK = 0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862;
    address constant BUNDLER = 0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c;
    address constant TOKEN_FACTORY = 0x1B37D3a72082029c44B35B604Ea473617580b69a;
    address constant NOOP_GOV = 0x85f37f74Ef2478A770318bc810177a9835911aD7;
    address constant INITIALIZER = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    address constant NOOP_MIGRATOR = 0xba2F330EDb16cD8056f5988d8CE19BbC63475A0e;
    address constant REHYPE = 0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    struct Config {
        address owner;
        address feeHub;
    }

    function run() external returns (address proxy, address impl) {
        address sender = msg.sender;
        Config memory cfg = Config({owner: vm.envAddress("ROUTER_OWNER"), feeHub: vm.envAddress("FEE_HUB")});
        require(cfg.owner != address(0) && cfg.feeHub != address(0), "zero address");
        if (cfg.owner == sender) console.log("WARNING: the sender (a hot key) is the router owner; transfer to a multisig before go-live");
        vm.startBroadcast();
        (proxy, impl) = deploy(cfg);
        vm.stopBroadcast();
        console.log("MultiplyLaunchRouter proxy:", proxy);
        console.log("implementation:", impl);
        console.log("owner:", cfg.owner);
        console.log("fee hub:", cfg.feeHub);
    }

    function deploy(Config memory cfg) public returns (address proxy, address impl) {
        MultiplyLaunchRouter implementation = new MultiplyLaunchRouter();
        bytes memory init = abi.encodeCall(MultiplyLaunchRouter.initialize, (cfg.owner, modules(), policy(cfg.feeHub)));
        proxy = address(new ERC1967Proxy(address(implementation), init));
        impl = address(implementation);
        // read back: the proxy must answer with exactly what was asked
        MultiplyLaunchRouter r = MultiplyLaunchRouter(proxy);
        require(r.owner() == cfg.owner, "owner mismatch");
        MultiplyLaunchRouter.Policy memory p = r.policy();
        require(p.feeHub == cfg.feeHub && p.numeraire == USDG && p.defaultMcap == 4_000e6, "policy mismatch");
        MultiplyLaunchRouter.Modules memory m = r.modules();
        require(m.airlock == AIRLOCK && m.rehype == REHYPE, "modules mismatch");
    }

    function modules() public pure returns (MultiplyLaunchRouter.Modules memory) {
        return MultiplyLaunchRouter.Modules({
            airlock: AIRLOCK,
            bundler: BUNDLER,
            tokenFactory: TOKEN_FACTORY,
            governanceFactory: NOOP_GOV,
            poolInitializer: INITIALIZER,
            liquidityMigrator: NOOP_MIGRATOR,
            rehype: REHYPE
        });
    }

    /// Launch economics at go-live; every value is owner-adjustable later with `setPolicy`.
    function policy(address feeHub) public pure returns (MultiplyLaunchRouter.Policy memory) {
        return MultiplyLaunchRouter.Policy({
            numeraire: USDG,
            feeHub: feeHub,
            protocolShareWad: 0.05e18, // Doppler's mandatory beneficiary minimum
            supply: 1e27, // 1B, 18 decimals
            defaultMcap: 4_000e6, // USDG, 6 decimals
            minMcap: 1_000e6,
            maxMcap: 100_000e6,
            minFee: 10_000, // 1%, hook fee in numeraire
            maxFee: 50_000, // 5%
            tickSpacing: 200,
            snipeStartFee: 800_000, // 80%, the Rehype cap
            snipeSeconds: 10
        });
    }
}
