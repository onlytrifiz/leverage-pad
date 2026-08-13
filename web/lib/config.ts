import path from "path";

/**
 * Config lato server. Il frontend e' SOLA LETTURA: nessuna chiave privata —
 * solo RPC pubblico, registry su disco e API pubblica Lighter.
 * Le costanti condivisibili col client stanno in clientConfig.ts.
 */
export {
  CHAIN_ID,
  V3_FACTORY,
  POSITION_MANAGER,
  SWAP_ROUTER,
  USDG,
  EXPLORER,
  explorerAddr,
  explorerTx,
  explorerToken,
} from "./clientConfig";

export const RPC_URL =
  process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const LOCKER = process.env.PERPSPAD_LOCKER || "";
export const TREASURY = process.env.PERPSPAD_TREASURY || "";

export const LIGHTER_API = "https://api.rh.lighter.xyz";

export const REGISTRY_PATH =
  process.env.PERPSPAD_REGISTRY_PATH ||
  path.resolve(process.cwd(), "..", "state", "registry.json");

/** demo forzata via env; altrimenti scatta da sola a registry vuoto */
export const FORCE_DEMO = process.env.PERPSPAD_WEB_DEMO === "1";
