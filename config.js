const path = require('path');
// standalone: perpspad/.env ha la precedenza; fallback al .env del monorepo se presente.
// dotenv non sovrascrive variabili gia' settate, quindi il primo caricato vince.
require('dotenv').config({ path: path.resolve(__dirname, '.env') });        // perpspad/.env (repo leverage-pad)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });  // fallback: robinhood-chain/.env

/**
 * config.js — costanti perpspad su Robinhood Chain (4663)
 *
 * Gli indirizzi V3 sono gli stessi di launchDirect.js; USDG e' il quote di
 * default (1 USDG = 1$, la valorizzazione in USD diventa banale). I parametri
 * economici replicano il whitepaper perpspad: split 50/15/20/15, gate $20 di
 * apertura perp, floor $25 per il buyback, payout creator minimo $1.
 */

module.exports = {
  CHAIN_ID: 4663,
  READ_URL: process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',

  // Uniswap V3 (Robinhood Chain)
  V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  POSITION_MANAGER: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  SWAP_ROUTER: '0xCaf681a66D020601342297493863E78C959E5cb2', // SwapRouter02

  // token noti
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // Global Dollar, 6 dec — quote di default

  // locker deployato (riempito da deployLocker.js — vuoto finche' non si deploya)
  LOCKER: process.env.PERPSPAD_LOCKER || '',

  // ── parametri di lancio (stile pons, come launchDirect) ─────────────────────
  DEFAULT_SUPPLY: '1000000000',   // 1B, tutta in pool one-sided
  DEFAULT_POOL_FEE: 10000,        // 1%, spacing 200
  DEFAULT_MCAP_USD: '1.3557',     // mcap iniziale in unita' quote (pons-equivalente)

  // ── economia keeper ─────────────────────────────────────────────────────────
  // Il whitepaper perpspad dichiara 50/15/20/15 (perp/creator/treasury/buyback), ma
  // il loro CODICE reale divide la partner-fee 50% perp / 25% buyback / 25% treasury,
  // con il 15% creator su un canale Meteora SEPARATO (creator.claimCreatorTradingFee).
  // Noi abbiamo UN solo flusso (il locker incassa tutto), quindi teniamo il creator
  // come slice di testa (15%, la promessa di prodotto) e applichiamo il loro rapporto
  // 50/25/25 al resto → perp 42.5% / buyback 21.25% / treasury 21.25% / creator 15%.
  // Ogni bucket e' override via env (in bps, somma DEVE fare 10000). perp = resto esatto.
  SPLIT_BPS: {
    perp: Number(process.env.PERPSPAD_SPLIT_PERP ?? 4250),
    creator: Number(process.env.PERPSPAD_SPLIT_CREATOR ?? 1500),
    treasury: Number(process.env.PERPSPAD_SPLIT_TREASURY ?? 2125),
    buyback: Number(process.env.PERPSPAD_SPLIT_BUYBACK ?? 2125),
  },
  OPEN_GATE_USD: 20,              // apre il perp quando la riserva perp arriva qui
  TOPUP_STEP_USD: 20,             // ogni +$20 di riserva → top-up collaterale
  PERP_WITHDRAW_FLOOR_USD: Number(process.env.PERPSPAD_PERP_WITHDRAW_FLOOR_USD || 25), // preleva il profitto realizzato da Lighter sopra questa soglia
  TP_MASTER_SHARE_BPS: Number(process.env.PERPSPAD_TP_MASTER_SHARE_BPS || 2500),       // del profitto rientrato: 25% treasury, 75% buyback (come perpspad)
  BUYBACK_FLOOR_USD: 25,          // sotto questa soglia il buyback aspetta
  BUYBACK_MAX_PER_TICK_USD: 25,   // un tick spende al massimo questo (niente ordini block-moving)
  BUYBACK_MAX_SLIPPAGE_BPS: Number(process.env.PERPSPAD_BUYBACK_SLIPPAGE_BPS || 300), // 3%: minOut dal prezzo spot
  CREATOR_MIN_PAYOUT_USD: 1,      // payout creator sotto $1 restano in accumulo
  CLAIM_MIN_USD: 0.5,             // non chiama collect() per briciole

  TICK_MS: Number(process.env.PERPSPAD_TICK_MS || 15000),

  // ── guardie operative del keeper ───────────────────────────────────────────
  MAX_GAS_PRICE_WEI: process.env.PERPSPAD_MAX_GAS_PRICE_WEI || '5000000000', // 5 gwei: cap anti-drain se l'RPC gonfia il gasPrice
  GAS_TICK_UNITS: 700000,         // gas del tick peggiore del sub-wallet (approve+swap+burn)
  GAS_TOPUP_MULT: 3,              // il top-up porta il sub-wallet a MULT × il costo del tick
  WAIT_TIMEOUT_MS: Number(process.env.PERPSPAD_WAIT_TIMEOUT_MS || 90000), // oltre → la tx e' "stuck", non blocca il loop

  // probe per il fingerprint del master secret (H3): address stabile derivato dal
  // secret, salvato in state/ e verificato a ogni lancio e all'avvio del keeper
  FINGERPRINT_PROBE: 'perpspad:fingerprint:v1',
  FINGERPRINT_PATH: path.resolve(__dirname, 'state', 'fingerprint.json'),

  // ── gamba perp: Lighter (profilo ROBINHOOD nativo, api.rh.lighter.xyz) ───────
  // Il collaterale entra da Robinhood Chain (4663) via intent-address; ogni
  // sub-wallet della coin e' il proprio account Lighter (isolamento per-coin).
  LIGHTER_PROFILE: process.env.PERPSPAD_LIGHTER_PROFILE || 'robinhood',
  LIGHTER_PYTHON: process.env.PERPSPAD_LIGHTER_PYTHON || 'python3', // interprete col lighter-sdk installato
  LIGHTER_API_KEY_INDEX: Number(process.env.PERPSPAD_LIGHTER_API_KEY_INDEX || 4), // 0-3 riservati a desktop/mobile
  LIGHTER_MAX_SLIPPAGE: Number(process.env.PERPSPAD_LIGHTER_MAX_SLIPPAGE || 0.02),  // 2% sugli ordini market
  LIGHTER_ISOLATED: process.env.PERPSPAD_LIGHTER_CROSS ? false : true,             // isolated di default

  // ── segreti / destinazioni ─────────────────────────────────────────────────
  // master secret per la derivazione HMAC dei sub-wallet (NON la chiave del deployer)
  MASTER_SECRET: process.env.PERPSPAD_MASTER_SECRET || '',
  // EOA che incassa la quota treasury (20%)
  TREASURY: process.env.PERPSPAD_TREASURY || '',
  // deployer per lanci e deploy contratti (condiviso col resto del repo)
  DEPLOYER_KEY: process.env.DEPLOYER_PRIVATE_KEY || process.env.LAUNCHER_PRIVATE_KEY || '',

  // file di stato
  REGISTRY_PATH: path.resolve(__dirname, 'state', 'registry.json'),
};
