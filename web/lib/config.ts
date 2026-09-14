import path from "path";

/**
 * Config lato server. Il frontend e' SOLA LETTURA: nessuna chiave privata —
 * solo RPC pubblico, registry su disco e API pubblica Lighter.
 * Le costanti condivisibili col client stanno in clientConfig.ts.
 */
export { CHAIN_ID, USDG, EXPLORER, explorerAddr, explorerTx, explorerToken } from "./clientConfig";

export const RPC_URL =
  process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const TREASURY = process.env.PERPSPAD_TREASURY || "";
/** dedicated IPFS gateway for token metadata (server only) */
export const PINATA_GATEWAY = process.env.PINATA_GATEWAY || "";

export const LIGHTER_API = "https://api.rh.lighter.xyz";

export const REGISTRY_PATH =
  process.env.PERPSPAD_REGISTRY_PATH ||
  path.resolve(process.cwd(), "..", "state", "registry.json");

/**
 * Snapshot pubblico pubblicato dal keeper (state/public.json servito via HTTP).
 * In deploy remoto e' l'UNICA sorgente possibile: il sito non condivide il
 * filesystem col keeper. Se assente si ricade sul file locale.
 */
export const REGISTRY_URL = process.env.PERPSPAD_REGISTRY_URL || "";

/** demo forzata via env; altrimenti scatta da sola a registry vuoto */
export const FORCE_DEMO = process.env.PERPSPAD_WEB_DEMO === "1";

/**
 * Engine thresholds live in `thresholds.ts` so client components quote the same
 * numbers; re-exported here to keep the server import path unchanged.
 */
export {
  OPEN_GATE_USD,
  TOPUP_STEP_USD,
  BUYBACK_FLOOR_USD,
  CREATOR_MIN_PAYOUT_USD,
  fmtThreshold,
} from "./thresholds";
