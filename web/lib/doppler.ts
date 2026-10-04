import { ethers } from "ethers";
import { PUBLIC_RPC, USDG, LAUNCH_FEE_HUB, DOPPLER, LAUNCH_ROUTER } from "./clientConfig";

/**
 * Launching through Doppler's Airlock on Uniswap v4, from the browser.
 *
 * `Airlock.create()` is permissionless and the launcher pays for the deploy
 * from their own wallet, so the launch no longer needs the operator's key.
 * Everything economic is calldata built here and validated by the contracts:
 *
 *   - the coin is a DopplerERC20V1 clone (1B fixed supply, no mint, real burn),
 *     governance and migrator are the no-op modules, so nothing has an admin;
 *   - the pool is one-sided from the launch tick (~$4k mcap) to the top, locked
 *     by its beneficiaries (the hub and Doppler's mandatory 5%);
 *   - the trading fee is NOT an LP fee (that is set to zero): it is taken by
 *     Doppler's Rehype hook, always attached, so it can land in USDG. A buy pays
 *     its fee in the coin and the hook swaps it into USDG inside the same call;
 *     a sell pays it in USDG already. Everything reaches the hub in USDG, minus
 *     Doppler's 5% slice of the fee;
 *   - launch protection is only the schedule of that fee: on, it opens at 80%
 *     and decays to the creator's fee over ten seconds; off, it is flat. Off by
 *     default;
 *   - the optional first buy goes through Doppler's Bundler, which creates the
 *     market and swaps in the same call frame: nobody can trade before it.
 *
 * The token URI is pinned to IPFS first (`/api/metadata`): a JSON with the seal
 * as `image`, per Doppler's metadata standard, plus the engine parameters under
 * `multiply`, so a coin describes itself and the keeper can adopt it later by
 * re-pointing the hub's share to the coin's sub-wallet
 * (`FeesManager.updateBeneficiary`, callable by the current beneficiary).
 */

const BN = ethers.BigNumber.from;
const WAD = BN(10).pow(18);
const coder = ethers.utils.defaultAbiCoder;

export const SUPPLY = BN(10).pow(27); // 1,000,000,000 × 1e18
export const OPEN_MCAP_USD = 4000;
export const TICK_SPACING = 200;
export const DYNAMIC_FEE_FLAG = 0x800000;

/** Trading-fee presets, 1e6-based (Rehype units; the hook caps a fee at 0.8e6). */
export const FEE_PRESETS = [
  { bps: 100, label: "1%" },
  { bps: 200, label: "2%" },
  { bps: 300, label: "3%" },
  { bps: 500, label: "5%" },
] as const;

/** Rehype anti-snipe schedule: opening fee and decay length when protection is on. */
export const SNIPE = { startFee: 800_000, seconds: 10 } as const;
/** The hook only flushes pending USDG fees to the hub once they exceed this (1e6 raw = 1 USDG). */
export const HOOK_FLUSH_EPSILON_USDG = 1;
/** Doppler's slice of every hook fee, also charged on the exempt first buy. */
export const DOPPLER_HOOK_FEE_BPS = 500;
/** What the bundled first buy pays to Doppler: 5% of the opening fee (80% with protection, the flat fee without). */
export const firstBuyDopplerCostPct = (feeBps: number, antiSnipe: boolean) =>
  ((antiSnipe ? SNIPE.startFee : feeBps * 100) / 1e6) * (DOPPLER_HOOK_FEE_BPS / 10_000) * 100;

export type EngineParams = {
  market: string;
  side: "long" | "short";
  leverage: number;
  /** each deposit banks at +takeProfitPct% on its collateral */
  takeProfitPct: number;
  /** the creator may retune leverage and take-profit later, after the router's notice */
  managed: boolean;
};

/*
 * The engine's bounds, as the router's EngineConfig and the keeper's config set them. Kept here
 * in one place for the launch form, the coin page and the docs; the router is the authority and
 * rejects anything outside them.
 */
export const ROUTER_LEVERAGES = [2, 3, 5, 10, 20, 25, 50] as const;
export const TP_MIN_PCT = 10;
export const TP_MAX_PCT = 500;
/** shortcuts on the take-profit slider: the three profiles every coin used to pick from */
export const TP_PRESETS = [
  { pct: 20, label: "safe" },
  { pct: 50, label: "balanced" },
  { pct: 100, label: "degen" },
  { pct: 300, label: "moon" },
] as const;
/** a managed coin's change waits this long before it applies */
export const MANAGED_DELAY_HOURS = 12;
/** the keeper's take-profit decay: from this day a deposit's target falls, reaching the floor at the end */
export const TP_DECAY = { startDays: 7, endDays: 30, floorPct: 10 } as const;

/**
 * A deposit's take-profit after `ageDays`: unchanged for the first `startDays`, then falling in
 * a straight line to the floor at `endDays`. A target already at or below the floor never moves.
 * Mirrors `effectiveTrigger` in the keeper.
 */
export function decayedTakeProfitPct(takeProfitPct: number, ageDays: number) {
  const floor = Math.min(takeProfitPct, TP_DECAY.floorPct);
  if (ageDays <= TP_DECAY.startDays) return takeProfitPct;
  if (ageDays >= TP_DECAY.endDays) return floor;
  const t = (ageDays - TP_DECAY.startDays) / (TP_DECAY.endDays - TP_DECAY.startDays);
  return takeProfitPct - (takeProfitPct - floor) * t;
}

/** coins launched before custom take-profits carried a named profile */
export const LEGACY_TP: Record<string, number> = { safe: 20, balanced: 50, degen: 100 };

export type LaunchConfig = {
  name: string;
  symbol: string;
  /** ipfs:// URI from /api/metadata; a data URI fallback keeps dry-runs self-contained */
  tokenURI?: string;
  /** airlock.owner(), Doppler's mandatory 5% beneficiary; read live, DOPPLER.safe is the fallback */
  protocolOwner?: string;
  engine: EngineParams;
  creator: string;
  feeBps: number;
  antiSnipe: boolean;
  salt: string;
};

/** Engine settings as a data URI: the simulation placeholder before metadata is pinned. */
export function engineTokenURI(engine: EngineParams, creator: string): string {
  const json = JSON.stringify({ p: "multiply", v: 1, ...engine, creator });
  return `data:application/json;base64,${ethers.utils.base64.encode(ethers.utils.toUtf8Bytes(json))}`;
}

/** One-sided ask ladder, expressed with the asset as token0; the initializer flips it if needed. */
export function launchTicks(mcapUsd = OPEN_MCAP_USD) {
  const price = (mcapUsd * 1e6) / Number(SUPPLY.toString());
  const tick = Math.round(Math.log(price) / Math.log(1.0001) / TICK_SPACING) * TICK_SPACING;
  const maxTick = Math.floor(887272 / TICK_SPACING) * TICK_SPACING;
  return { tick, maxTick, mcapUsd: Math.pow(1.0001, tick) * 1e12 * 1e9 };
}

export function randomSalt(): string {
  return ethers.utils.hexlify(ethers.utils.randomBytes(32));
}

export type CreateParams = {
  initialSupply: ethers.BigNumber;
  numTokensToSell: ethers.BigNumber;
  numeraire: string;
  tokenFactory: string;
  tokenFactoryData: string;
  governanceFactory: string;
  governanceFactoryData: string;
  poolInitializer: string;
  poolInitializerData: string;
  liquidityMigrator: string;
  liquidityMigratorData: string;
  integrator: string;
  salt: string;
};

export function buildCreateParams(cfg: LaunchConfig): CreateParams {
  const { tick, maxTick } = launchTicks();
  const tokenFactoryData = coder.encode(
    ["string", "string", "tuple(uint64 cliff,uint64 duration)[]", "address[]", "uint256[]", "uint256[]", "string", "uint256", "uint48", "address", "address[]"],
    [cfg.name, cfg.symbol, [], [], [], [], cfg.tokenURI || engineTokenURI(cfg.engine, cfg.creator), 0, 0, ethers.constants.AddressZero, []]
  );
  // The hook is always attached; protection only shapes the fee schedule. Coin-side fees are
  // swapped into USDG inside the hook, USDG-side fees pass straight through: the hub sees USDG only.
  const feePips = cfg.feeBps * 100;
  const rehypeInit = coder.encode(
    ["tuple(address numeraire,address buybackDst,uint24 startFee,uint24 endFee,uint32 durationSeconds,uint32 startingTime,uint8 feeRoutingMode,tuple(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) fdi,tuple(address beneficiary,uint96 shares)[] feeBeneficiaries)"],
    [{
      numeraire: USDG,
      buybackDst: LAUNCH_FEE_HUB,
      startFee: cfg.antiSnipe ? SNIPE.startFee : feePips,
      endFee: feePips,
      durationSeconds: cfg.antiSnipe ? SNIPE.seconds : 0,
      startingTime: 0,
      feeRoutingMode: 0,
      fdi: [0, WAD, 0, 0, 0, WAD, 0, 0], // asset fees → swapped to USDG; USDG fees → direct
      feeBeneficiaries: [],
    }]
  );
  const beneficiaries = [
    { beneficiary: cfg.protocolOwner || DOPPLER.safe, shares: WAD.div(20) },
    { beneficiary: LAUNCH_FEE_HUB, shares: WAD.mul(95).div(100) },
  ].sort((a, b) => (BN(a.beneficiary).lt(b.beneficiary) ? -1 : 1));
  const poolInitializerData = coder.encode(
    ["tuple(uint24 fee,int24 tickSpacing,int24 farTick,tuple(int24 tickLower,int24 tickUpper,uint16 numPositions,uint256 shares)[] curves,tuple(address beneficiary,uint96 shares)[] beneficiaries,address dopplerHook,bytes onInit,bytes grad)"],
    [{
      fee: 0, // no LP fee: the hook takes the trading fee so it can land in USDG
      tickSpacing: TICK_SPACING,
      farTick: maxTick - TICK_SPACING, // must sit strictly below the top of the ladder
      curves: [{ tickLower: tick, tickUpper: maxTick, numPositions: 1, shares: WAD }],
      beneficiaries,
      dopplerHook: DOPPLER.rehype,
      onInit: rehypeInit,
      grad: "0x",
    }]
  );
  return {
    initialSupply: SUPPLY,
    numTokensToSell: SUPPLY,
    numeraire: USDG,
    tokenFactory: DOPPLER.tokenFactory,
    tokenFactoryData,
    governanceFactory: DOPPLER.noOpGovernance,
    governanceFactoryData: "0x",
    poolInitializer: DOPPLER.hookInitializer,
    poolInitializerData,
    liquidityMigrator: DOPPLER.noOpMigrator,
    liquidityMigratorData: "0x",
    integrator: LAUNCH_FEE_HUB,
    salt: cfg.salt,
  };
}

const CREATE_TUPLE =
  "(uint256 initialSupply,uint256 numTokensToSell,address numeraire,address tokenFactory,bytes tokenFactoryData,address governanceFactory,bytes governanceFactoryData,address poolInitializer,bytes poolInitializerData,address liquidityMigrator,bytes liquidityMigratorData,address integrator,bytes32 salt)";

export const AIRLOCK_IFACE = new ethers.utils.Interface([
  `function create(${CREATE_TUPLE} params) returns (address asset,address pool,address governance,address timelock,address migrationPool)`,
]);
export const BUNDLER_IFACE = new ethers.utils.Interface([
  `function bundle(${CREATE_TUPLE} createData,(bool permissionlessClaim,uint64 vestingDuration,uint64 cliffDuration) vestingData,uint128 exactAmountIn,address recipient) payable returns (address asset,(address,address,uint24,int24,address) poolKey,address governance,address timelock,uint128 amountOut)`,
  `function simulateBundle(${CREATE_TUPLE} createData,uint128 exactAmountIn) returns (address asset,(address,address,uint24,int24,address) poolKey,address governance,address timelock,uint128 amountOut)`,
]);
export const AIRLOCK_OWNER_IFACE = new ethers.utils.Interface(["function owner() view returns (address)"]);
export const ERC20_IFACE = new ethers.utils.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

export function encodeCreate(params: CreateParams): string {
  return AIRLOCK_IFACE.encodeFunctionData("create", [params]);
}

export function encodeBundle(params: CreateParams, usdgIn: ethers.BigNumber, recipient: string): string {
  return BUNDLER_IFACE.encodeFunctionData("bundle", [
    params,
    { permissionlessClaim: false, vestingDuration: 0, cliffDuration: 0 },
    usdgIn,
    recipient,
  ]);
}

export const readProvider = new ethers.providers.StaticJsonRpcProvider(PUBLIC_RPC, {
  chainId: 4663,
  name: "robinhood",
});

/**
 * Dry-runs `Airlock.create` from the launcher's address. The token address
 * depends on the salt alone, so this is the address the launch will produce.
 */
export async function simulateCreate(from: string, params: CreateParams) {
  const ret = await readProvider.call({ from, to: DOPPLER.airlock, data: encodeCreate(params) });
  const [asset, pool] = AIRLOCK_IFACE.decodeFunctionResult("create", ret);
  return { asset: asset as string, pool: pool as string };
}

/**
 * Dry-runs the whole bundle (create + first buy) through the Bundler's own simulator. It runs
 * with `payer = address(0)` and never pulls tokens, so no allowance is needed: this is the
 * exact revert the wallet would see, plus the tokens the first buy would receive.
 */
export async function simulateBundle(from: string, params: CreateParams, usdgIn: ethers.BigNumber) {
  const ret = await readProvider.call({
    from,
    to: DOPPLER.bundler,
    data: BUNDLER_IFACE.encodeFunctionData("simulateBundle", [params, usdgIn]),
  });
  const [asset, , , , amountOut] = BUNDLER_IFACE.decodeFunctionResult("simulateBundle", ret);
  return { asset: asset as string, amountOut: amountOut as ethers.BigNumber };
}

/** Doppler's protocol beneficiary, read live so an owner rotation cannot break launches. */
export async function readProtocolOwner(): Promise<string> {
  try {
    const ret = await readProvider.call({ to: DOPPLER.airlock, data: AIRLOCK_OWNER_IFACE.encodeFunctionData("owner") });
    return AIRLOCK_OWNER_IFACE.decodeFunctionResult("owner", ret)[0] as string;
  } catch {
    return DOPPLER.safe;
  }
}

/** The message a creator signs so only the wallet that launches can pin metadata under its address. */
export function metadataSignMessage(input: { name: string; symbol: string; creator: string; engine: EngineParams; ts: number }) {
  const e = input.engine;
  return [
    "multiply.cash metadata",
    `name: ${input.name}`,
    `symbol: ${input.symbol}`,
    `engine: ${e.market} ${e.side} ${e.leverage}x +${e.takeProfitPct}%${e.managed ? " managed" : ""}`,
    `creator: ${input.creator.toLowerCase()}`,
    `ts: ${input.ts}`,
  ].join("\n");
}

// ── the launch router ──────────────────────────────────────────────────────
// The router builds the CreateParams on-chain from these inputs (policy: mcap bounds, fee range,
// protection schedule, hub, modules) and namespaces the salt per launcher. The encoders above are
// kept in sync with it so the browser can predict the token address before signing.

/** Name and ticker are free-form; only a length cap, for gas and layout. Mirrors lib/launchParams.js. */
export const NAME_MAX = 64;
export const SYMBOL_MAX = 16;

/** The router's side enum, in the order the contract declares it. */
export const ENGINE_SIDES = ["long", "short"] as const;

export type RouterInput = {
  name: string;
  symbol: string;
  tokenURI: string;
  fee: number; // 1e6-based hook fee
  antiSnipe: boolean;
  mcap: ethers.BigNumberish; // 0 = policy default
  firstBuy: ethers.BigNumberish; // USDG raw, 0 = none
  salt: string;
  // the engine, on-chain: the router validates it and emits MultiplyEngine for the keeper
  market: string;
  side: number; // index into ENGINE_SIDES
  leverage: number;
  takeProfitPct: number;
  managed: boolean;
};

export function routerEngine(e: EngineParams): Pick<RouterInput, "market" | "side" | "leverage" | "takeProfitPct" | "managed"> {
  return {
    market: e.market.toUpperCase(),
    side: ENGINE_SIDES.indexOf(e.side),
    leverage: e.leverage,
    takeProfitPct: Math.round(e.takeProfitPct),
    managed: e.managed,
  };
}

export const ROUTER_IFACE = new ethers.utils.Interface([
  "function launch((string name,string symbol,string tokenURI,uint24 fee,bool antiSnipe,uint256 mcap,uint128 firstBuy,bytes32 salt,string market,uint8 side,uint8 leverage,uint16 takeProfitPct,bool managed) input) returns (address asset,bytes32 poolId,uint128 firstBuyOut)",
  "function validEngine(string market,uint8 side,uint8 leverage,uint16 takeProfitPct) view returns (bool)",
  "event MultiplyEngine(address indexed asset, string market, uint8 side, uint8 leverage, uint16 takeProfitPct, bool managed, address indexed creator)",
  // stored engines (router upgrade of 2026-10-05): the current values, and a managed coin's announced change
  "function engineOf(address asset) view returns ((string market,uint8 side,uint8 leverage,uint16 takeProfitPct,bool managed,address creator,uint8 pendingLeverage,uint16 pendingTakeProfitPct,uint64 pendingAt))",
  "function engineConfig() view returns ((uint64 leverageMask,uint16 minTakeProfitPct,uint16 maxTakeProfitPct,uint32 managedDelay))",
  "function proposeEngine(address asset,uint8 leverage,uint16 takeProfitPct)",
  "function cancelEngineProposal(address asset)",
  "function saltFor(address launcher,bytes32 salt) pure returns (bytes32)",
  "function policy() view returns ((address numeraire,address feeHub,uint256 protocolShareWad,uint256 supply,uint256 defaultMcap,uint256 minMcap,uint256 maxMcap,uint24 minFee,uint24 maxFee,int24 tickSpacing,uint24 snipeStartFee,uint32 snipeSeconds))",
  // per-coin fee sinks (router upgrade of 2026-09-15); absent on the pre-upgrade implementation
  "function sinkConfig() view returns ((address implementation,address keeper,address treasury,uint16 treasuryBps))",
  "function predictSink(address launcher,bytes32 salt) view returns (address)",
  "function sinkOf(address asset) view returns (address)",
  "event FeeSink(address indexed asset, address indexed sink)",
]);

export function encodeRouterLaunch(input: RouterInput): string {
  return ROUTER_IFACE.encodeFunctionData("launch", [input]);
}

/**
 * How a launch's fee is split, as the router will actually do it. `sink` is the coin's own
 * fee contract (known before the launch: it depends on launcher and salt alone). `null` when
 * the router has no sink configured, in which case every fee goes to the policy hub.
 *
 * Doppler keeps its slice on the hook before anything reaches the sink, so the engine's share
 * is what is left after the treasury's: 100 − doppler − treasury.
 */
export type FeeSplit = { sink: string; treasuryBps: number; treasury: string; engineBps: number };

/**
 * The split as configured on the router at go-live, for copy that renders without a wallet
 * (docs). The router's `sinkConfig()` is the source of truth; `readFeeSplit` reads it live.
 */
export const FEE_SPLIT_PCT = { doppler: 5, treasury: 15, engine: 80 } as const;

const DOPPLER_HOOK_BPS = DOPPLER_HOOK_FEE_BPS; // 500: Doppler's slice of every hook fee

export async function readFeeSplit(launcher: string, salt: string): Promise<FeeSplit | null> {
  try {
    const router = new ethers.Contract(LAUNCH_ROUTER, ROUTER_IFACE, readProvider);
    const cfg = await router.sinkConfig();
    if (!cfg.implementation || BN(cfg.implementation).isZero()) return null;
    const sink = (await router.predictSink(launcher, salt)) as string;
    const treasuryBps = Number(cfg.treasuryBps);
    return { sink, treasuryBps, treasury: cfg.treasury as string, engineBps: 10_000 - DOPPLER_HOOK_BPS - treasuryBps };
  } catch {
    return null; // pre-upgrade router (no such functions) or RPC hiccup: show the hub
  }
}

/** The salt the router actually sends to the Airlock: keccak(launcher, salt). */
export function routerSalt(launcher: string, salt: string): string {
  return ethers.utils.solidityKeccak256(["address", "bytes32"], [launcher, salt]);
}

/**
 * Dry-runs `router.launch` from the launcher. Exact for launches without a first buy; with a
 * first buy the router pulls USDG first, so before the approval this reverts on allowance and
 * the caller should fall back to `simulateBundle` with the router-namespaced salt.
 */
export async function simulateRouterLaunch(from: string, input: RouterInput) {
  const ret = await readProvider.call({ from, to: LAUNCH_ROUTER, data: encodeRouterLaunch(input) });
  const [asset, poolId, firstBuyOut] = ROUTER_IFACE.decodeFunctionResult("launch", ret);
  return { asset: asset as string, poolId: poolId as string, firstBuyOut: firstBuyOut as ethers.BigNumber };
}

/** v4 pool id of a launched coin: keccak of its PoolKey. */
export function poolIdFor(asset: string): string {
  const assetIs0 = BN(asset).lt(BN(USDG));
  const key = coder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [assetIs0 ? asset : USDG, assetIs0 ? USDG : asset, DYNAMIC_FEE_FLAG, TICK_SPACING, DOPPLER.hookInitializer]
  );
  return ethers.utils.keccak256(key);
}

export const dexscreenerPool = (poolId: string) => `https://dexscreener.com/robinhood/${poolId}`;
