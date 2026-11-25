/**
 * Writes lib/router-logs.json: every log of the launch router up to a recent block, so the site
 * never rescans history. Run it now and then (node scripts/router-logs.mjs); between runs the site
 * reads only the blocks after it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const ROUTER = "0xB9De90F875FFE04D57cC90EE030c0DfB84F25Acd";
const DEPLOY_BLOCK = 80058837;
const STEP = 400_000;
const FILE = new URL("../lib/router-logs.json", import.meta.url);

async function rpc(method, params) {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).catch(() => null);
    if (r?.ok) {
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    }
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
  throw new Error(`${method}: no answer`);
}
const hex = (n) => "0x" + n.toString(16);

let prev = { router: ROUTER, upTo: DEPLOY_BLOCK - 1, logs: [] };
try {
  const saved = JSON.parse(readFileSync(FILE, "utf8"));
  if (saved.router === ROUTER) prev = saved;
} catch {}
const end = parseInt(await rpc("eth_blockNumber", []), 16) - 1000;
const logs = [...prev.logs];
for (let from = prev.upTo + 1; from <= end; from += STEP) {
  const to = Math.min(end, from + STEP - 1);
  for (const l of await rpc("eth_getLogs", [{ address: ROUTER, fromBlock: hex(from), toBlock: hex(to) }])) {
    logs.push({ blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16), transactionHash: l.transactionHash, topics: l.topics, data: l.data });
  }
}
writeFileSync(FILE, JSON.stringify({ router: ROUTER, upTo: end, logs }, null, 1) + "\n");
console.log(`${logs.length} logs up to ${end}`);
