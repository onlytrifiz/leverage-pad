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

  // ── Uniswap v4 / Doppler (coin lanciate dal router, docs.doppler.lol/reference/contract-addresses) ──
  LAUNCH_ROUTER: process.env.PERPSPAD_LAUNCH_ROUTER || '0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd', // MultiplyLaunchRouter (proxy UUPS)
  // first block worth scanning for launches: TEST8, the first coin through the sink-enabled router
  // (block 80,058,837). Earlier router history is only test launches and is skipped on purpose.
  ROUTER_DEPLOY_BLOCK: Number(process.env.PERPSPAD_LAUNCH_ROUTER_BLOCK || 80058837),
  V4_POOL_MANAGER: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  V4_HOOK_INITIALIZER: '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544', // DopplerHookInitializer = hook della PoolKey
  V4_TICK_SPACING: 200,
  V4_SUPPLY_RAW: '1000000000000000000000000000', // 1B × 1e18, fissato dal router
  REHYPE: '0x5F9eB5f6726Fe88D5e39867967F5b833d2fA3215',
  UNIVERSAL_ROUTER: '0x8876789976dEcBfCbBbe364623C63652db8C0904', // Universal Router di Doppler, encoding 2.1.1
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  V4_QUOTER: '0xce6cd4e35447e05a39a50a4bcf61f2dcd93a8f0d', // Doppler Quoter (hookless: la hook fee va scontata a parte)
  PERMIT2_EXPIRY_S: 3600, // allowance Permit2 del sub-wallet verso l'Universal Router: per-buyback, un'ora

  // ── parametri di lancio ─────────────────────────────────────────────────────
  DEFAULT_SUPPLY: '1000000000',   // 1B, tutta in pool one-sided
  DEFAULT_POOL_FEE: 10000,        // 1%, spacing 200
  DEFAULT_MCAP_USD: '4000',       // mcap iniziale in unita' quote (in linea coi launchpad)

  // ── economia keeper ─────────────────────────────────────────────────────────
  // Split multiply.cash: 100% perp — full degen. TUTTE le fee (lato quote)
  // diventano collaterale della posizione. Il protocollo guadagna SOLO dal 25%
  // del profitto perp che rientra (TP_MASTER_SHARE_BPS); il restante 75% fa
  // buyback&burn, piu' il burn del lato coin delle fee a ogni tick.
  // Ogni bucket resta override via env (bps, somma DEVE fare 10000).
  SPLIT_BPS: {
    perp: Number(process.env.PERPSPAD_SPLIT_PERP ?? 10000),
    creator: Number(process.env.PERPSPAD_SPLIT_CREATOR ?? 0),
    treasury: Number(process.env.PERPSPAD_SPLIT_TREASURY ?? 0),
    buyback: Number(process.env.PERPSPAD_SPLIT_BUYBACK ?? 0),
  },
  OPEN_GATE_USD: Number(process.env.PERPSPAD_OPEN_GATE_USD || 20),   // apre il perp quando la riserva arriva qui
  TOPUP_STEP_USD: Number(process.env.PERPSPAD_TOPUP_STEP_USD || 20), // ogni +N$ di riserva → top-up collaterale

  // ── profili di rischio del take-profit (scelti al lancio, --risk) ───────────
  // Il TP e' PER TRANCHE: ogni deposito/topup e' una tranche col suo entry, e
  // quando il suo PnL raggiunge +triggerPct (sul collaterale della tranche, cioe'
  // il sottostante si muove di triggerPct/leva dal suo entry) la tranche si
  // chiude TUTTA e realizza. Niente diluizione da topup: ogni dollaro di fee
  // corre verso il proprio target.
  // Override via env (utili per tuning e per i test end-to-end: abbassare il
  // trigger fa scattare il take-profit senza aspettare il movimento reale).
  RISK_PROFILES: {
    safe: { triggerPct: Number(process.env.PERPSPAD_RISK_SAFE ?? 0.20) },          // ogni tranche incassa a +20%
    balanced: { triggerPct: Number(process.env.PERPSPAD_RISK_BALANCED ?? 0.50) },  // ogni tranche incassa a +50%
    degen: { triggerPct: Number(process.env.PERPSPAD_RISK_DEGEN ?? 1.00) },        // ogni tranche incassa a +100%
  },
  DEFAULT_RISK: 'balanced',
  // Preleva il profitto realizzato da Lighter sopra questa soglia. Lighter rifiuta
  // i prelievi piccoli ("withdrawal amount is too small", misurato: $0.07 no) —
  // tenere il floor ben sopra quel minimo evita cicli di rifiuto inutili.
  PERP_WITHDRAW_FLOOR_USD: Number(process.env.PERPSPAD_PERP_WITHDRAW_FLOOR_USD || 25),
  TP_MASTER_SHARE_BPS: Number(process.env.PERPSPAD_TP_MASTER_SHARE_BPS || 2500),       // del profitto rientrato: 25% treasury, 75% buyback (come perpspad)
  BUYBACK_FLOOR_USD: Number(process.env.PERPSPAD_BUYBACK_FLOOR_USD || 25),        // sotto questa soglia il buyback aspetta
  BUYBACK_MAX_PER_TICK_USD: Number(process.env.PERPSPAD_BUYBACK_MAX_USD || 25),   // un tick spende al massimo questo (niente ordini block-moving)
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
  // Quota del collaterale libero effettivamente impiegata all'apertura. Lighter
  // calcola il margine richiesto sul prezzo di ESECUZIONE: impiegando il 100% del
  // saldo, basta un tick di prezzo sfavorevole tra la lettura del mark e il fill
  // perche' il requisito superi il disponibile e l'ordine venga scartato IN SILENZIO
  // (misurato live: $22 di notional su $2.20 → nessun fill; $15 → fill regolare).
  COLLATERAL_HEADROOM: Number(process.env.PERPSPAD_COLLATERAL_HEADROOM || 0.95),
  // Sotto questa cifra il collaterale libero non viene impiegato: quando il saldo
  // "libero" e' gonfiato dal PnL non ancora realizzato, tentare l'apertura produce
  // solo fill-scheggia (l'exchange concede il margine sul realizzato, non sul
  // potenziale). Accumulare e' meglio che sporcare la scala di tranche inchiudibili.
  MIN_DEPLOY_USD: Number(process.env.PERPSPAD_MIN_DEPLOY_USD || 2),
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
