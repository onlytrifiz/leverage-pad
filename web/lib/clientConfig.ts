/** Constants shareable with the browser: no Node imports, no secrets. */

/**
 * The chain, as one object. Every transaction has to name it, so it must be
 * impossible to reach for the id without also having the metadata needed to
 * add or switch to it.
 */
export const CHAIN = {
  id: 4663,
  hex: "0x1237",
  name: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

export const CHAIN_ID = CHAIN.id;
export const CHAIN_HEX = CHAIN.hex;
export const PUBLIC_RPC = CHAIN.rpc;
export const EXPLORER = CHAIN.explorer;

/**
 * Lo stream pubblico di Lighter (profilo Robinhood): mark, book e posizioni in
 * push. I canali di sola lettura non chiedono auth — anche quelli di un conto,
 * che qui e' l'unica ragione per cui la pagina di una coin puo' mostrare la sua
 * posizione dal vivo senza avere in mano nessuna chiave.
 */
export const LIGHTER_WS = "wss://api.rh.lighter.xyz/stream";

export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/**
 * Doppler's official Robinhood Chain deployment (docs.doppler.lol/reference/contract-addresses),
 * verified on Blockscout. `safe` is `airlock.owner()`: the protocol multisig that every locked
 * pool must carry as a beneficiary with at least 5%.
 */
export const DOPPLER = {
  airlock: "0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862",
  bundler: "0xf45588e8e0b1df9db9ae7e20ece5726ae931357c",
  tokenFactory: "0x1B37D3a72082029c44B35B604Ea473617580b69a",
  noOpGovernance: "0x85f37f74Ef2478A770318bc810177a9835911aD7",
  noOpMigrator: "0xba2F330EDb16cD8056f5988d8CE19BbC63475A0e",
  hookInitializer: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544",
  rehype: "0x5f9eb5f6726fe88d5e39867967f5b833d2fa3215",
  safe: "0x21E2ce70511e4FE542a97708e89520471DAa7A66",
} as const;

/** Uniswap v4 on Robinhood Chain (official deployment via the CREATE2 deployer). */
export const V4_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * Where a newly launched coin's 95% of the LP fee accrues until the keeper adopts it.
 * The keeper holds this key and re-points the share to the coin's own sub-wallet with
 * `FeesManager.updateBeneficiary`. Public address, no secret reaches the browser.
 */
export const LAUNCH_FEE_HUB =
  process.env.NEXT_PUBLIC_LAUNCH_FEE_HUB || "0x23Bf247B662EFADf114642A65DbbB0CB7D0EBAc0";

/**
 * multiply.cash launch router (UUPS proxy, stable address) in front of Doppler's Airlock:
 * builds the whole launch from a handful of inputs so every coin has the same shape.
 */
export const LAUNCH_ROUTER =
  process.env.NEXT_PUBLIC_LAUNCH_ROUTER || "0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd";
/** block the router was deployed in: launch logs start here */
export const ROUTER_DEPLOY_BLOCK = Number(process.env.NEXT_PUBLIC_LAUNCH_ROUTER_BLOCK || 63095128);

/** Canonical Multicall3 — verified deployed at this address on chain 4663. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const explorerAddr = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerToken = (a: string) => `${EXPLORER}/token/${a}`;
