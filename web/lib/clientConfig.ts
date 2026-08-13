/** costanti condivisibili col browser: nessun import Node, nessun segreto */

export const CHAIN_ID = 4663;
export const CHAIN_HEX = "0x1237";
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const POSITION_MANAGER = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
export const SWAP_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const explorerAddr = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerToken = (a: string) => `${EXPLORER}/token/${a}`;
