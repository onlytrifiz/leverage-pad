const { ethers } = require('ethers');

/** Multicall3, at the address it has on almost every chain */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const IFACE = new ethers.utils.Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])']);

/**
 * calls: [{ target, iface, fn, args }] → the decoded results in order, null for a call that failed.
 * A batch that cannot be read throws: a failed read is not an empty answer.
 */
async function multicall(provider, calls, { size = 300 } = {}) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const part = calls.slice(i, i + size);
    const data = IFACE.encodeFunctionData('aggregate3', [part.map((c) => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args || []) }))]);
    const [rows] = IFACE.decodeFunctionResult('aggregate3', await provider.call({ to: MULTICALL3, data }));
    if (rows.length !== part.length) throw new Error('multicall: incomplete answer');
    rows.forEach((r, k) => {
      if (!r.success || r.returnData === '0x') return out.push(null);
      try { out.push(part[k].iface.decodeFunctionResult(part[k].fn, r.returnData)); } catch { out.push(null); }
    });
  }
  return out;
}

module.exports = { multicall, MULTICALL3 };
