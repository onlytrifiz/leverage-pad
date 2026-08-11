const { ethers } = require('ethers');
const config = require('../config');

/**
 * chain.js — provider, helper ERC20 e valorizzazione USD dei quote.
 *
 * priceUsd: USDG vale 1 per definizione. Per quote diversi (WETH, stock token)
 * il prezzo va da Rialto (/quote) o da un pool USDG di riferimento — per ora
 * override manuale via env PERPSPAD_PRICE_<SYMBOL>, altrimenti errore esplicito:
 * meglio fermarsi che valorizzare a caso i gate in dollari.
 */

const provider = new ethers.providers.JsonRpcProvider(config.READ_URL);

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function burn(uint256 value)',
];

const erc20 = (addr, signerOrProvider) => new ethers.Contract(addr, ERC20_ABI, signerOrProvider || provider);

async function tokenMeta(addr) {
  const c = erc20(addr);
  const [name, symbol, decimals] = await Promise.all([c.name(), c.symbol(), c.decimals()]);
  return { address: addr, name, symbol, decimals };
}

function priceUsd(quoteAddr, quoteSymbol) {
  if (quoteAddr.toLowerCase() === config.USDG.toLowerCase()) return 1;
  const env = process.env['PERPSPAD_PRICE_' + String(quoteSymbol).toUpperCase()];
  if (env && Number(env) > 0) return Number(env);
  throw new Error(`prezzo USD sconosciuto per ${quoteSymbol} (${quoteAddr}): setta PERPSPAD_PRICE_${String(quoteSymbol).toUpperCase()} o usa USDG come quote`);
}

// value raw → USD (float, solo per gate/log: mai per importi on-chain)
function usdOf(amountRaw, decimals, unitUsd) {
  return Number(ethers.utils.formatUnits(amountRaw, decimals)) * unitUsd;
}

// USD → raw del quote (per dimensionare swap/payout)
function rawFromUsd(usd, decimals, unitUsd) {
  return ethers.utils.parseUnits((usd / unitUsd).toFixed(decimals), decimals);
}

async function gasPrice() {
  const gp = await provider.getGasPrice();
  return gp.mul(12).div(10);
}

module.exports = { provider, erc20, ERC20_ABI, tokenMeta, priceUsd, usdOf, rawFromUsd, gasPrice };
