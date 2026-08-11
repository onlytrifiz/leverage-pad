const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const config = require('./config');
const { provider, erc20, priceUsd, usdOf, rawFromUsd, gasPrice } = require('./lib/chain');
const { deriveSubWallet, checkFingerprint } = require('./lib/subwallet');
const { buildSwapCalldata } = require('./lib/v3');
const registry = require('./lib/registry');
const lighter = require('./lighter/client');

/**
 * keeper.js — il loop perpspad su Robinhood Chain
 *
 * Ogni TICK_MS, per ogni coin nel registry:
 *   1. CLAIM     locker.collect(lpTokenId): le fee (coin + quote) arrivano al
 *                sub-wallet. Gli importi REALI si misurano dal delta di balance
 *                attorno alla collect (non dalla static: la static predice, la tx
 *                incassa un valore diverso — la deriva si accumulerebbe).
 *   2. SPLIT     lato quote 50/15/20/15 (perp/creator/treasury/buyback) — bps da
 *                config, resto dell'intero al bucket perp (somma esatta al wei).
 *   3. BURN      lato coin: bruciato l'intero saldo coin del sub-wallet (recupera
 *                anche eventuali residui di burn falliti in passato).
 *   4. PAYOUT    creator e treasury pagati appena il dovuto supera $1.
 *   5. BUYBACK   sopra $25: swap quote→coin (max $25/tick) con amountOutMinimum
 *                reale dal prezzo spot (anti-sandwich), poi burn.
 *   6. PERP      la riserva 50% accumula nel sub-wallet; al gate $20 → lighter
 *                (stub in fase 1).
 *
 * Sicurezza dei fondi:
 *  - CHECKPOINT per-step: lo stato si salva DOPO ogni tx e, per payout/buyback,
 *    il bucket si decrementa e si salva PRIMA di inviare. Un crash hard lascia
 *    quindi un UNDER-pay (fondi fermi nel sub-wallet, riconciliabili) e mai un
 *    DOUBLE-pay. Un fallimento soft ripristina il bucket e si ritenta al tick dopo.
 *  - LOCKFILE single-instance: due keeper condividerebbero sub-wallet/nonce.
 *  - Cap su gasPrice per il funding dei sub-wallet (anti-drain da RPC ostile).
 *  - Timeout su wait(): una tx "stuck" non congela l'intero loop.
 *
 * Uso: node keeper.js [--once] [--coin 0x…]
 */

const flag = (name) => process.argv.includes('--' + name);
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ts = () => new Date().toISOString().slice(11, 19);
const BN = ethers.BigNumber.from;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOCKER_ABI = [
  'function collect(uint256 tokenId) returns (uint256 amount0, uint256 amount1)',
  'function feeRecipient(uint256) view returns (address)',
];
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
];
const LOCKFILE = path.resolve(__dirname, 'state', 'keeper.lock');
const Q96 = BN(2).pow(96);

function keeperWallet() {
  const key = process.env.PERPSPAD_KEEPER_KEY || config.DEPLOYER_KEY;
  if (!key) throw new Error('PERPSPAD_KEEPER_KEY o DEPLOYER_PRIVATE_KEY mancante');
  return new ethers.Wallet(key, provider);
}

// gasPrice usato per INVIARE, sempre cappato: un RPC ostile che gonfia il prezzo
// non deve poter dimensionare top-up enormi ne' bruciare gas a piacere.
async function cappedGasPrice() {
  const gp = await gasPrice();
  const cap = BN(config.MAX_GAS_PRICE_WEI);
  return gp.gt(cap) ? cap : gp;
}

// wait() con timeout: oltre WAIT_TIMEOUT_MS la tx e' considerata "stuck" e si
// solleva un errore (soft) invece di bloccare il loop per sempre.
async function waitOrTimeout(txResp, label) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}: tx ${txResp.hash} non minata entro ${config.WAIT_TIMEOUT_MS}ms (stuck)`)), config.WAIT_TIMEOUT_MS); });
  try { return await Promise.race([txResp.wait(), timeout]); }
  finally { clearTimeout(timer); }
}

async function send(wallet, tx, label) {
  const r = await wallet.sendTransaction({ gasPrice: await cappedGasPrice(), type: 0, ...tx });
  const rc = await waitOrTimeout(r, label);
  if (rc.status !== 1) throw new Error(label + ' revertata: ' + r.hash);
  return rc;
}

// il sub-wallet paga gas per burn/payout/swap: il keeper lo tiene rifornito.
// Floor e top-up dal gasPrice CAPPATO (non manipolabile oltre il cap).
async function ensureGas(keeper, subAddr) {
  const gp = await cappedGasPrice();
  const floor = gp.mul(config.GAS_TICK_UNITS);
  const bal = await provider.getBalance(subAddr);
  if (bal.gte(floor)) return;
  const topup = floor.mul(config.GAS_TOPUP_MULT);
  console.log(`  gas top-up ${subAddr} (+${ethers.utils.formatEther(topup)} ETH)`);
  await send(keeper, { to: subAddr, value: topup, gasLimit: 21000 }, 'gas top-up');
}

async function burnCoin(sub, coinToken, amount, st) {
  if (amount.isZero()) return;
  const c = erc20(coinToken, sub);
  try {
    await send(sub, { to: coinToken, data: c.interface.encodeFunctionData('burn', [amount]), gasLimit: 80000 }, 'burn');
  } catch {
    await send(sub, { to: coinToken, data: c.interface.encodeFunctionData('transfer', ['0x000000000000000000000000000000000000dEaD', amount]), gasLimit: 80000 }, 'burn(dead)');
  }
  st.totalBurnedRaw = BN(st.totalBurnedRaw).add(amount).toString();
}

// output ESATTO di un exact-in swap V3 in un range a liquidita' costante (i pool
// perpspad sono a posizione singola one-sided → L costante nel range: esatto).
// Formule canoniche SqrtPriceMath, identiche a uniQuote.js del repo.
function quoteExactInV3(sqrtP, L, amountInNet, zeroForOne) {
  if (zeroForOne) {
    // token0 in → token1 out, prezzo scende
    const sqrtNext = L.mul(Q96).mul(sqrtP).div(L.mul(Q96).add(amountInNet.mul(sqrtP)));
    return L.mul(sqrtP.sub(sqrtNext)).div(Q96);
  }
  // token1 in → token0 out, prezzo sale
  const sqrtNext = sqrtP.add(amountInNet.mul(Q96).div(L));
  return L.mul(Q96).mul(sqrtNext.sub(sqrtP)).div(sqrtNext.mul(sqrtP));
}

// minOut del buyback: quoto l'output reale al prezzo/liquidita' CORRENTI del pool
// (tiene conto dell'impatto di prezzo) e tolgo la tolleranza di slippage. Se un
// sandwich/volume ha spostato il prezzo tra il quote e l'esecuzione, lo swap
// reverta e si ritenta al tick dopo — niente leak da amountOutMinimum:0.
async function buybackMinOut(coin, quoteIs0, spendRaw) {
  const pool = new ethers.Contract(coin.pool, POOL_ABI, provider);
  const [{ sqrtPriceX96 }, L] = await Promise.all([pool.slot0(), pool.liquidity()]);
  const net = spendRaw.mul(1000000 - coin.fee).div(1000000); // fee presa sull'input
  const out = quoteExactInV3(sqrtPriceX96, L, net, quoteIs0); // quote in = token0 ⇔ zeroForOne
  return out.mul(10000 - config.BUYBACK_MAX_SLIPPAGE_BPS).div(10000);
}

async function tickCoin(keeper, locker, coin, st, checkpoint) {
  const token = coin.token;
  const sub = deriveSubWallet(token, provider);
  const quoteIs0 = BN(coin.pair).lt(BN(token));
  const unitUsd = priceUsd(coin.pair, coin.pairSymbol);
  const quote = erc20(coin.pair);
  const coinC = erc20(token);

  // ── 0. RICONCILIA il profitto perp rientrato da Lighter ─────────────────────
  // Quando un withdraw da Lighter atterra, il sub-wallet ha piu' USDG di quanto i
  // bucket USDG-denominati (buyback+creator+treasury+perpReserve) contabilizzano.
  // Solo se c'e' un withdraw in volo (perpWithdrawPendingUsd>0) attribuiamo il
  // surplus (cap al pending) come profitto realizzato: 75% buyback / 25% treasury.
  if (Number(st.perpWithdrawPendingUsd) > 0) {
    const accounted = BN(st.buybackReserveRaw).add(st.creatorOwedRaw).add(st.treasuryOwedRaw).add(st.perpReserveRaw);
    const real = await quote.balanceOf(sub.address);
    const surplus = real.gt(accounted) ? real.sub(accounted) : ethers.constants.Zero;
    const pendingRaw = rawFromUsd(Number(st.perpWithdrawPendingUsd), coin.pairDecimals, unitUsd);
    const creditRaw = surplus.lt(pendingRaw) ? surplus : pendingRaw;
    if (usdOf(creditRaw, coin.pairDecimals, unitUsd) >= config.CLAIM_MIN_USD) {
      const toTreasury = creditRaw.mul(config.TP_MASTER_SHARE_BPS).div(10000);
      const toBuyback = creditRaw.sub(toTreasury);
      st.buybackReserveRaw = BN(st.buybackReserveRaw).add(toBuyback).toString();
      st.treasuryOwedRaw = BN(st.treasuryOwedRaw).add(toTreasury).toString();
      st.perpWithdrawPendingUsd = Math.max(0, Number(st.perpWithdrawPendingUsd) - usdOf(creditRaw, coin.pairDecimals, unitUsd));
      checkpoint();
      console.log(`  [${coin.symbol}] profitto perp rientrato: $${usdOf(creditRaw, coin.pairDecimals, unitUsd).toFixed(2)} → 75% buyback / 25% treasury`);
    }
  }

  // ── 1. CLAIM: decidi con la static, misura col delta reale ──────────────────
  let est;
  try { const [a0, a1] = await locker.callStatic.collect(coin.lpTokenId); est = quoteIs0 ? a0 : a1; }
  catch (e) { console.log(`  [${coin.symbol}] static collect fallita: ${e.message.slice(0, 80)}`); return; }

  if (usdOf(est, coin.pairDecimals, unitUsd) >= config.CLAIM_MIN_USD) {
    const quoteBefore = await quote.balanceOf(sub.address);
    await send(keeper, { to: config.LOCKER, data: locker.interface.encodeFunctionData('collect', [coin.lpTokenId]), gasLimit: 300000 }, 'collect');
    const realQuote = (await quote.balanceOf(sub.address)).sub(quoteBefore); // fee quote REALMENTE incassate
    st.totalCollected0 = BN(st.totalCollected0).add(realQuote).toString();

    // ── 2. SPLIT (resto al perp: somma esatta) ───────────────────────────────
    const creatorCut = realQuote.mul(config.SPLIT_BPS.creator).div(10000);
    const treasuryCut = realQuote.mul(config.SPLIT_BPS.treasury).div(10000);
    const buybackCut = realQuote.mul(config.SPLIT_BPS.buyback).div(10000);
    const perpCut = realQuote.sub(creatorCut).sub(treasuryCut).sub(buybackCut);
    st.perpReserveRaw = BN(st.perpReserveRaw).add(perpCut).toString();
    st.creatorOwedRaw = BN(st.creatorOwedRaw).add(creatorCut).toString();
    st.treasuryOwedRaw = BN(st.treasuryOwedRaw).add(treasuryCut).toString();
    st.buybackReserveRaw = BN(st.buybackReserveRaw).add(buybackCut).toString();
    checkpoint(); // stato coerente con la collect gia' avvenuta
    console.log(`  [${coin.symbol}] claim: ${ethers.utils.formatUnits(realQuote, coin.pairDecimals)} ${coin.pairSymbol} ($${usdOf(realQuote, coin.pairDecimals, unitUsd).toFixed(2)})`);
  }

  // ── 3. BURN lato coin: brucia l'INTERO saldo coin del sub-wallet ───────────
  //     (fee lato coin di questo claim + eventuali residui di burn passati falliti)
  const coinBal = await coinC.balanceOf(sub.address);
  if (coinBal.gt(0)) {
    await ensureGas(keeper, sub.address);
    await burnCoin(sub, token, coinBal, st);
    checkpoint();
    console.log(`  [${coin.symbol}] burn lato coin: ${ethers.utils.formatEther(coinBal)} ${coin.symbol}`);
  }

  // ── 4. PAYOUT creator + treasury (min $1), save-before-send ────────────────
  for (const [bucket, dest, label] of [
    ['creatorOwedRaw', coin.creator, 'creator'],
    ['treasuryOwedRaw', config.TREASURY, 'treasury'],
  ]) {
    const owed = BN(st[bucket]);
    if (owed.isZero()) continue;
    if (!dest) { if (bucket === 'treasuryOwedRaw') console.log(`  [${coin.symbol}] PERPSPAD_TREASURY non settata: accumulo`); continue; }
    if (usdOf(owed, coin.pairDecimals, unitUsd) < config.CREATOR_MIN_PAYOUT_USD) continue;
    await ensureGas(keeper, sub.address);
    st[bucket] = '0'; checkpoint(); // decremento PRIMA dell'invio: un crash → under-pay, mai double-pay
    try {
      await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('transfer', [dest, owed]), gasLimit: 100000 }, label);
      console.log(`  [${coin.symbol}] payout ${label}: ${ethers.utils.formatUnits(owed, coin.pairDecimals)} ${coin.pairSymbol} → ${dest}`);
    } catch (e) { st[bucket] = owed.toString(); checkpoint(); throw e; } // soft-fail: ripristina e ritenta al tick dopo
  }

  // ── 5. BUYBACK & BURN (floor $25, max $25/tick, slippage reale) ────────────
  const bbUsd = usdOf(BN(st.buybackReserveRaw), coin.pairDecimals, unitUsd);
  if (bbUsd >= config.BUYBACK_FLOOR_USD) {
    const spendUsd = Math.min(bbUsd, config.BUYBACK_MAX_PER_TICK_USD);
    let spendRaw = rawFromUsd(spendUsd, coin.pairDecimals, unitUsd);
    if (spendRaw.gt(BN(st.buybackReserveRaw))) spendRaw = BN(st.buybackReserveRaw);
    await ensureGas(keeper, sub.address);
    const allowance = await quote.allowance(sub.address, config.SWAP_ROUTER);
    if (allowance.lt(spendRaw)) {
      await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('approve', [config.SWAP_ROUTER, ethers.constants.MaxUint256]), gasLimit: 80000 }, 'approve router');
    }
    const minOut = await buybackMinOut(coin, quoteIs0, spendRaw);
    st.buybackReserveRaw = BN(st.buybackReserveRaw).sub(spendRaw).toString(); checkpoint(); // decremento prima dell'invio
    try {
      const before = await coinC.balanceOf(sub.address);
      const data = buildSwapCalldata({ tokenIn: coin.pair, tokenOut: token, fee: coin.fee, recipient: sub.address, amountIn: spendRaw, amountOutMinimum: minOut });
      await send(sub, { to: config.SWAP_ROUTER, data, gasLimit: 400000 }, 'buyback swap');
      const bought = (await coinC.balanceOf(sub.address)).sub(before);
      await burnCoin(sub, token, bought, st);
      checkpoint();
      console.log(`  [${coin.symbol}] BUYBACK&BURN: $${spendUsd.toFixed(2)} → ${ethers.utils.formatEther(bought)} ${coin.symbol} bruciati (minOut ${ethers.utils.formatEther(minOut)})`);
    } catch (e) { st.buybackReserveRaw = BN(st.buybackReserveRaw).add(spendRaw).toString(); checkpoint(); console.log(`  [${coin.symbol}] buyback fallito (slippage?), riprovo al tick dopo: ${e.message.slice(0, 80)}`); }
  }

  // ── 6. PERP su Lighter (o stub) ───────────────────────────────────────────
  const perpUsd = usdOf(BN(st.perpReserveRaw), coin.pairDecimals, unitUsd);
  if (lighter.enabled) {
    try { await perpTick(keeper, coin, st, checkpoint, sub, unitUsd, quote); }
    catch (e) { console.log(`  [${coin.symbol}] perp: ${e.message.slice(0, 140)}`); }
  } else if (perpUsd >= config.OPEN_GATE_USD && !st.perpGateLogged) {
    console.log(`  [${coin.symbol}] PERP (stub): riserva $${perpUsd.toFixed(2)} ≥ $${config.OPEN_GATE_USD} → ${coin.market} ${coin.side} ${coin.leverage}x quando Lighter sara' attivo (PERPSPAD_LIGHTER_ENABLED)`);
    st.perpGateLogged = true; checkpoint();
  }

  st.lastTickTs = Date.now();
}

// ── gamba perp su Lighter (profilo ROBINHOOD) ───────────────────────────────
// Collaterale USDG che entra da Robinhood Chain (4663) via intent-address; ogni
// sub-wallet e' il proprio account Lighter. Contabilita' conservativa: la riserva
// perp si decrementa SOLO quando gli USDG lasciano davvero il sub-wallet verso
// l'intent-address; il profitto realizzato resta su Lighter (serve un withdraw
// per bruciarlo) e NON viene accreditato al buyback finche' non torna on-chain.
async function perpTick(keeper, coin, st, checkpoint, sub, unitUsd, quote) {
  if (coin.pair.toLowerCase() !== config.USDG.toLowerCase()) {
    if (!st.perpGateLogged) { console.log(`  [${coin.symbol}] perp saltato: quote non USDG (il collaterale Lighter e' USDG)`); st.perpGateLogged = true; checkpoint(); }
    return;
  }
  const sim = lighter.simulate; // dry-run: letture ok, nessuna tx/ordine
  const tag = sim ? 'SIMULATE ' : '';
  // mercato Lighter della coin (BTC, NVDA, NVDA/USDG, …)
  const mkt = await lighter.market(coin.market);
  const marketIndex = mkt.index;
  const isAsk = coin.side === 'short'; // long = buy (is_ask false)

  // 1) DEPOSITO: manda la riserva accumulata all'intent-address (tx reale su 4663)
  const perpUsd = usdOf(BN(st.perpReserveRaw), coin.pairDecimals, unitUsd);
  const gate = st.perpOpen ? config.TOPUP_STEP_USD : config.OPEN_GATE_USD;
  if (perpUsd >= gate) {
    const depositRaw = BN(st.perpReserveRaw);
    const { intentAddress } = await lighter.intentAddress({ chainId: '4663', fromAddr: sub.address, amount: depositRaw.toString() });
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}perp deposit: depositerei $${perpUsd.toFixed(2)} USDG → Lighter (intent ${intentAddress})`);
    } else {
      await ensureGas(keeper, sub.address);
      st.perpReserveRaw = '0'; st.perpPendingDepositUsd += perpUsd; checkpoint(); // decremento prima dell'invio (crash → under-deposit, riconciliabile)
      try {
        await send(sub, { to: coin.pair, data: quote.interface.encodeFunctionData('transfer', [intentAddress, depositRaw]), gasLimit: 100000 }, 'perp deposit');
        st.perpDepositedUsd += perpUsd; checkpoint();
        console.log(`  [${coin.symbol}] perp deposit: $${perpUsd.toFixed(2)} USDG → Lighter (intent ${intentAddress})`);
      } catch (e) { st.perpReserveRaw = depositRaw.toString(); st.perpPendingDepositUsd -= perpUsd; checkpoint(); throw e; }
    }
  }

  // 2) account Lighter della coin (creato al primo deposito accreditato)
  let accountIndex = st.lighterAccountIndex;
  if (accountIndex == null) {
    const r = await lighter.resolveAccount(sub.address);
    if (r.accountIndex == null) { if (sim) console.log(`  [${coin.symbol}] ${tag}account Lighter non ancora attivo (nessun deposito accreditato)`); return; }
    accountIndex = r.accountIndex;
    if (!sim) { st.lighterAccountIndex = accountIndex; checkpoint(); }
    console.log(`  [${coin.symbol}] ${tag}account Lighter ${accountIndex} attivo`);
  }

  // 3) chiave API della coin (per firmare gli ordini); registrata con la chiave del sub-wallet
  if (!st.lighterApiPrivKey) {
    if (sim) { console.log(`  [${coin.symbol}] ${tag}registrerei la chiave API (idx ${config.LIGHTER_API_KEY_INDEX})`); return; }
    const r = await lighter.registerKey({ accountIndex, apiKeyIndex: config.LIGHTER_API_KEY_INDEX, ethPrivKey: sub.privateKey });
    st.lighterApiPrivKey = r.apiPrivKey; st.lighterApiKeyIndex = r.apiKeyIndex; checkpoint();
    console.log(`  [${coin.symbol}] chiave API Lighter registrata (idx ${r.apiKeyIndex})`);
  }
  const apiPrivKey = st.lighterApiPrivKey, apiKeyIndex = st.lighterApiKeyIndex;

  // 4) leva isolata, una volta
  if (!st.lighterLeverageSet) {
    if (sim) { console.log(`  [${coin.symbol}] ${tag}imposterei leva ${coin.leverage}x ${config.LIGHTER_ISOLATED ? 'isolated' : 'cross'}`); }
    else {
      await lighter.setLeverage({ accountIndex, marketIndex, leverage: coin.leverage, isolated: config.LIGHTER_ISOLATED, apiPrivKey, apiKeyIndex });
      st.lighterLeverageSet = true; checkpoint();
      console.log(`  [${coin.symbol}] leva ${coin.leverage}x ${config.LIGHTER_ISOLATED ? 'isolated' : 'cross'} impostata su ${coin.market}`);
    }
  }

  // 5) stato conto/posizione
  const acc = await lighter.account(accountIndex);
  const pos = (acc.positions || []).find((p) => Number(p.market_id) === Number(marketIndex));
  const freeCollateralUsd = Number(acc.collateral || 0); // collaterale libero (non allocato)

  // 6) OPEN / TOPUP: deploya il collaterale libero al leverage scelto
  if (freeCollateralUsd >= 1) {
    const notionalUsd = freeCollateralUsd * coin.leverage;
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}perp ${st.perpOpen ? 'topup' : 'open'}: aprirei notional $${notionalUsd.toFixed(2)} ${coin.side} ${coin.leverage}x (collaterale libero $${freeCollateralUsd.toFixed(2)})`);
    } else {
      const r = await lighter.open({ accountIndex, marketIndex, notionalUsd, isAsk, maxSlippage: config.LIGHTER_MAX_SLIPPAGE, clientOrderIndex: Date.now() % 1000000, apiPrivKey, apiKeyIndex });
      st.perpOpen = true; st.perpCollateralUsd += freeCollateralUsd; st.perpPendingDepositUsd = Math.max(0, st.perpPendingDepositUsd - freeCollateralUsd); checkpoint();
      console.log(`  [${coin.symbol}] perp ${st.perpOpen ? 'topup' : 'open'}: notional $${notionalUsd.toFixed(2)} ${coin.side} ${coin.leverage}x (base ${r.baseAmount})`);
    }
  }

  // 7) TAKE-PROFIT a scaglioni: +25% del collaterale della posizione sopra l'HWM → chiudi 20%
  if (pos && pos.size != null && pos.unrealized_pnl != null && pos.allocated_margin) {
    const pnl = Number(pos.unrealized_pnl), posColl = Number(pos.allocated_margin), size = Math.abs(Number(pos.size));
    if (isFinite(pnl) && isFinite(posColl) && posColl > 0 && isFinite(size) && size > 0) {
      if (pnl - Number(st.perpHwmUsd) >= 0.25 * posColl) {
        const closeBase = Math.round(size * 0.20 * (10 ** mkt.sizeDec)); // 20% della size, scalata
        if (closeBase > 0) {
          if (sim) {
            console.log(`  [${coin.symbol}] ${tag}TAKE-PROFIT: chiuderei 20% (base ${closeBase}), realizzerei ~$${(0.25 * posColl).toFixed(2)}`);
          } else {
            await lighter.close({ accountIndex, marketIndex, baseAmount: closeBase, isAsk: !isAsk, maxSlippage: config.LIGHTER_MAX_SLIPPAGE, apiPrivKey, apiKeyIndex });
            const realized = 0.25 * posColl; // profitto bloccato in questo scaglione
            st.perpHwmUsd = pnl; st.perpRealizedUsd += realized; checkpoint();
            console.log(`  [${coin.symbol}] TAKE-PROFIT: chiuso 20% (base ${closeBase}), realizzato ~$${realized.toFixed(2)}`);
          }
        }
      }
    }
  }

  // 8) WITHDRAW del profitto realizzato → sub-wallet su 4663 (poi la riconciliazione
  //    a inizio tick lo splitta 75% buyback / 25% treasury). No fee/limite sul withdraw normale.
  if (Number(st.perpRealizedUsd) >= config.PERP_WITHDRAW_FLOOR_USD) {
    const amount = Number(st.perpRealizedUsd);
    if (sim) {
      console.log(`  [${coin.symbol}] ${tag}preleverei $${amount.toFixed(2)} di profitto da Lighter → sub-wallet`);
    } else {
      await lighter.withdraw({ accountIndex, amount, apiPrivKey, apiKeyIndex });
      st.perpRealizedUsd = 0; st.perpWithdrawPendingUsd += amount; checkpoint();
      console.log(`  [${coin.symbol}] withdraw profitto: $${amount.toFixed(2)} da Lighter → sub-wallet (in arrivo)`);
    }
  }
}

// lockfile single-instance: se ne esiste uno con PID vivo, rifiuta l'avvio.
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCKFILE), { recursive: true });
  if (fs.existsSync(LOCKFILE)) {
    const pid = Number(JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')).pid);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive) throw new Error(`un altro keeper e' gia' attivo (pid ${pid}). Chiudilo o cancella ${LOCKFILE} se e' morto male.`);
    console.log(`lockfile stantio (pid ${pid} morto), lo rilevo`);
  }
  fs.writeFileSync(LOCKFILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const release = () => { try { if (JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCKFILE); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
}

function validateSplit() {
  const s = config.SPLIT_BPS;
  const sum = s.perp + s.creator + s.treasury + s.buyback;
  if (sum !== 10000) throw new Error(`SPLIT_BPS non somma a 10000 (${sum}): config errata`);
}

async function main() {
  validateSplit();
  if (!config.LOCKER) throw new Error('PERPSPAD_LOCKER mancante nel .env');
  if (!config.MASTER_SECRET) throw new Error('PERPSPAD_MASTER_SECRET mancante nel .env');
  checkFingerprint(); // stesso master secret con cui sono stati lockati i sub-wallet?
  acquireLock();

  const keeper = keeperWallet();
  const locker = new ethers.Contract(config.LOCKER, LOCKER_ABI, keeper);
  const only = arg('coin', null);
  console.log(`keeper ${keeper.address} | locker ${config.LOCKER} | tick ${config.TICK_MS}ms | lighter:${lighter.mode}${only ? ' | solo ' + only : ''}`);

  do {
    const reg = registry.load();
    const checkpoint = () => registry.save(reg);
    const coins = reg.coins.filter((c) => !only || c.token.toLowerCase() === only.toLowerCase());
    if (!coins.length) console.log(ts() + ' nessuna coin nel registry');
    for (const coin of coins) {
      const st = reg.state[coin.token.toLowerCase()];
      if (!st) { console.log(`  [${coin.symbol}] stato mancante nel registry, salto`); continue; }
      try { await tickCoin(keeper, locker, coin, st, checkpoint); }
      catch (e) { console.log(`  [${coin.symbol}] ERRORE tick: ${e.message.slice(0, 140)}`); }
      registry.save(reg);
    }
    if (!flag('once')) await sleep(config.TICK_MS);
  } while (!flag('once'));
}

main().catch((e) => { console.error('Errore fatale:', e.message); process.exit(1); });
