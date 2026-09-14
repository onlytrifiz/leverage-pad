require('dotenv').config();
const { ethers } = require('ethers');
const config = require('./config');
const registry = require('./lib/registry');
const { provider, erc20, gasPrice } = require('./lib/chain');
const { buildSwapCalldata } = require('./lib/v3');
const { quoteExactInV3 } = require('./keeper');

/**
 * swap.js — generatore di volume per i test operativi.
 *
 * Compra e rivende una coin sulla sua pool per accendere il circuito che il
 * resto del sistema aspetta: fee dell'1% → claim del locker → burn del lato
 * coin → USDG al sub-wallet → deposito perp. Senza volume quel circuito e'
 * fermo e il sito resta con chart e feed vuoti, che e' esattamente lo stato
 * in cui si trovano le coin di test.
 *
 * Riusa router, matematica di quote (`quoteExactInV3`) e builder di calldata
 * del keeper: se il prezzo torna qui, torna anche nel buyback. Nessuna logica
 * di pricing duplicata.
 *
 * DRY DI DEFAULT: senza `--send` non parte nessuna transazione, si vedono solo
 * i quote. E' denaro vero su mainnet, l'invio va chiesto esplicitamente.
 *
 * Uso:
 *   node swap.js --coin TEST2 --usd 4 --rounds 7            (anteprima)
 *   node swap.js --coin TEST2 --usd 4 --rounds 7 --send     (esegue)
 *   node swap.js --coin TEST2 --usd 4 --side buy --send     (solo acquisto)
 */

const BN = ethers.BigNumber.from;
const ts = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (n) => process.argv.includes('--' + n);
function arg(n, def) {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ROUTER = config.SWAP_ROUTER;
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
];

/** gasPrice sempre cappato, come nel keeper: un RPC ostile non detta il prezzo */
async function cappedGasPrice() {
  const gp = await gasPrice();
  const cap = BN(config.MAX_GAS_PRICE_WEI);
  return gp.gt(cap) ? cap : gp;
}

async function send(wallet, tx, label) {
  const sent = await wallet.sendTransaction({ ...tx, gasPrice: await cappedGasPrice() });
  process.stdout.write(`  ${label} → ${sent.hash.slice(0, 12)}… `);
  const rc = await sent.wait();
  console.log(rc.status === 1 ? 'ok' : 'FALLITA');
  if (rc.status !== 1) throw new Error(`${label} fallita`);
  return rc;
}

/**
 * Prezzo spot dal pool in USDG per coin. sqrtPriceX96 e' il prezzo di token1
 * in termini di token0; qui lo normalizzo sempre a "quanto USDG vale una coin"
 * tenendo conto di chi dei due e' token0 e dei decimali diversi (6 vs 18).
 */
function spotUsd(sqrtPriceX96, coinIs0, coinDec, pairDec) {
  const p = Number(sqrtPriceX96.toString()) ** 2 / 2 ** 192; // token1 per token0
  const raw = coinIs0 ? p : 1 / p;                            // pair per coin
  return raw * 10 ** (coinDec - pairDec);
}

async function main() {
  const reg = registry.load();
  const key = arg('coin', '');
  if (!key) throw new Error('serve --coin <indirizzo|simbolo>');
  const coin = reg.coins.find(
    (c) => c.token.toLowerCase() === key.toLowerCase() || c.symbol.toLowerCase() === key.toLowerCase()
  );
  if (!coin) throw new Error(`coin "${key}" non trovata nel registry`);

  const usd = Number(arg('usd', '4'));
  const rounds = Number(arg('rounds', '1'));
  const side = arg('side', 'round');            // buy | sell | round
  const slipBps = Number(arg('slippage-bps', String(config.BUYBACK_MAX_SLIPPAGE_BPS)));
  const waitMs = Number(arg('wait', '4000'));
  const live = flag('send');
  if (!['buy', 'sell', 'round'].includes(side)) throw new Error('--side deve essere buy, sell o round');
  if (!(usd > 0) || !(rounds > 0)) throw new Error('--usd e --rounds devono essere positivi');

  const wallet = new ethers.Wallet(config.DEPLOYER_KEY, provider);
  const pool = new ethers.Contract(coin.pool, POOL_ABI, provider);
  const quoteC = erc20(coin.pair);
  const coinC = erc20(coin.token);
  const coinIs0 = BN(coin.token).lt(BN(coin.pair));

  const [{ sqrtPriceX96 }, quoteBal, coinBal, eth] = await Promise.all([
    pool.slot0(), quoteC.balanceOf(wallet.address), coinC.balanceOf(wallet.address), provider.getBalance(wallet.address),
  ]);

  const legs = side === 'round' ? rounds * 2 : rounds;
  const volumeUsd = usd * legs;
  const feesUsd = volumeUsd * (coin.fee / 1e6);

  console.log(`\n${coin.symbol} · ${coin.leverage}x ${coin.side} ${coin.market}`);
  console.log(`pool ${coin.pool}  fee ${coin.fee / 10000}%`);
  console.log(`prezzo spot     $${spotUsd(sqrtPriceX96, coinIs0, 18, coin.pairDecimals).toPrecision(6)}`);
  console.log(`operatore       ${wallet.address}`);
  console.log(`  ${coin.pairSymbol.padEnd(6)} ${ethers.utils.formatUnits(quoteBal, coin.pairDecimals)}`);
  console.log(`  ${coin.symbol.padEnd(6)} ${ethers.utils.formatUnits(coinBal, 18)}`);
  console.log(`  gas    ${ethers.utils.formatEther(eth)} ETH`);
  console.log(`\npiano: ${rounds} × ${side} da $${usd} = ${legs} leg, volume $${volumeUsd.toFixed(2)}`);
  console.log(`fee generate ~$${feesUsd.toFixed(2)} → vanno nel motore della coin, non perse`);
  console.log(`slippage max ${slipBps / 100}%${live ? '' : '   [DRY — nessun invio, aggiungi --send]'}\n`);

  if (live && usd > Number(ethers.utils.formatUnits(quoteBal, coin.pairDecimals))) {
    throw new Error(`saldo ${coin.pairSymbol} insufficiente per un leg da $${usd}`);
  }

  /** un leg: quota sul prezzo corrente, applica lo slippage, manda (se --send) */
  async function leg(dir, amountIn) {
    const tokenIn = dir === 'buy' ? coin.pair : coin.token;
    const tokenOut = dir === 'buy' ? coin.token : coin.pair;
    const inDec = dir === 'buy' ? coin.pairDecimals : 18;
    const outDec = dir === 'buy' ? 18 : coin.pairDecimals;
    const inSym = dir === 'buy' ? coin.pairSymbol : coin.symbol;
    const outSym = dir === 'buy' ? coin.symbol : coin.pairSymbol;

    const [{ sqrtPriceX96: sp }, L] = await Promise.all([pool.slot0(), pool.liquidity()]);
    const net = amountIn.mul(1e6 - coin.fee).div(1e6);
    // zeroForOne ⇔ il token che entra e' token0 (fra i due dell'unica pool)
    const out = quoteExactInV3(sp, L, net, BN(tokenIn).lt(BN(tokenOut)));
    const minOut = out.mul(10000 - slipBps).div(10000);
    const fmtIn = ethers.utils.formatUnits(amountIn, inDec);
    const fmtOut = ethers.utils.formatUnits(out, outDec);
    console.log(`${ts()} ${dir.padEnd(4)} ${Number(fmtIn).toFixed(4)} ${inSym} → ~${Number(fmtOut).toFixed(4)} ${outSym}`);
    // in dry restituisco il quote: cosi' l'anteprima del round-trip mostra anche
    // la gamba di vendita, che altrimenti partirebbe da un saldo ricevuto a zero
    if (!live) return out;
    if (out.isZero()) throw new Error('quote a zero: pool senza liquidita nel range');

    const inC = erc20(tokenIn);
    const allowance = await inC.allowance(wallet.address, ROUTER);
    if (allowance.lt(amountIn)) {
      await send(wallet, { to: tokenIn, data: inC.interface.encodeFunctionData('approve', [ROUTER, ethers.constants.MaxUint256]), gasLimit: 80000 }, `approve ${inSym}`);
    }
    const outC = erc20(tokenOut);
    const before = await outC.balanceOf(wallet.address);
    const data = buildSwapCalldata({
      tokenIn, tokenOut, fee: coin.fee, recipient: wallet.address,
      amountIn, amountOutMinimum: minOut,
    });
    await send(wallet, { to: ROUTER, data, gasLimit: 400000 }, `swap ${dir}`);
    const got = (await outC.balanceOf(wallet.address)).sub(before);
    console.log(`         ricevuti ${Number(ethers.utils.formatUnits(got, outDec)).toFixed(4)} ${outSym}`);
    return got;
  }

  const amountUsd = ethers.utils.parseUnits(String(usd), coin.pairDecimals);
  for (let i = 1; i <= rounds; i++) {
    console.log(`— round ${i}/${rounds} —`);
    if (side === 'buy' || side === 'round') {
      const got = await leg('buy', amountUsd);
      if (side === 'round') {
        if (live) await sleep(waitMs);
        // rivendo esattamente quanto ricevuto: il round-trip non lascia inventario
        await leg('sell', got);
      }
    } else {
      const bal = await coinC.balanceOf(wallet.address);
      if (bal.isZero()) throw new Error('nessuna coin da vendere');
      await leg('sell', bal);
    }
    if (live && i < rounds) await sleep(waitMs);
  }

  if (live) {
    const { sqrtPriceX96: after } = await pool.slot0();
    console.log(`\nprezzo spot dopo $${spotUsd(after, coinIs0, 18, coin.pairDecimals).toPrecision(6)}`);
    console.log(`volume generato  $${volumeUsd.toFixed(2)} · fee al motore ~$${feesUsd.toFixed(2)}`);
    console.log(`il keeper claima sopra $${config.CLAIM_MIN_USD} e deposita sopra $${config.OPEN_GATE_USD}\n`);
  }
}

main().catch((e) => { console.error('Errore:', e.message); process.exit(1); });
