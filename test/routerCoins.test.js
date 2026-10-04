const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

process.env.PERPSPAD_MASTER_SECRET = process.env.PERPSPAD_MASTER_SECRET || 'test-secret-for-dry-tests';
const config = require('../config');
const rc = require('../lib/routerCoins');
const { deriveSubWallet } = require('../lib/subwallet');

const ASSET = '0x3335F28a0Dc28808849ed1025695f1f6ee2ef5D2';
const LAUNCHER = '0x23Bf247B662EFADf114642A65DbbB0CB7D0EBAc0';
const POOL = '0x3c1fb4f38b8415e1be5d19b5b5efd5d765b195660ee70d7de901924f0ce0b252';
const URI = 'ipfs://bafkreiazkosvsyrp24xbvqeoyihoxbidgbt24ih24ter26lj5mez36amw4';

function launchLog() {
  const ev = rc.ROUTER_IFACE.getEvent('MultiplyLaunch');
  const { data, topics } = rc.ROUTER_IFACE.encodeEventLog(ev, [ASSET, LAUNCHER, POOL, 30_000, true, 4_000e6, -400600, 3e6, ethers.utils.parseEther('1159992'), URI]);
  return { address: config.LAUNCH_ROUTER, data, topics, blockNumber: 63_100_000, transactionHash: '0x' + 'ab'.repeat(32) };
}
function engineLog(market = 'NVDA', side = 0, leverage = 3, takeProfitPct = 100, managed = false, creator = LAUNCHER) {
  const ev = rc.ROUTER_IFACE.getEvent('MultiplyEngine');
  const { data, topics } = rc.ROUTER_IFACE.encodeEventLog(ev, [ASSET, market, side, leverage, takeProfitPct, managed, creator]);
  return { address: config.LAUNCH_ROUTER, data, topics, blockNumber: 63_100_000, transactionHash: '0x' + 'ab'.repeat(32) };
}

test('parseLaunchLog: the event becomes a plain, checksummed record', () => {
  const l = rc.parseLaunchLog(launchLog());
  assert.equal(l.token, ASSET);
  assert.equal(l.launcher, LAUNCHER);
  assert.equal(l.poolId, POOL);
  assert.equal(l.fee, 30_000);
  assert.equal(l.antiSnipe, true);
  assert.equal(l.mcapRaw, '4000000000');
  assert.equal(l.tick, -400600);
  assert.equal(l.firstBuyRaw, '3000000');
  assert.equal(l.tokenURI, URI);
  assert.equal(l.launchBlock, 63_100_000);
});

test('parseEngineLog: the new event, side decoded, take-profit, managed and creator carried', () => {
  assert.deepEqual(rc.parseEngineLog(engineLog('TSLA', 1, 5, 50)), {
    token: ASSET, market: 'TSLA', side: 'short', leverage: 5, takeProfitPct: 50, managed: false, creator: LAUNCHER,
  });
  const other = '0x1111111111111111111111111111111111111111';
  const e = rc.parseEngineLog(engineLog('BTC', 0, 50, 500, true, other.toLowerCase()));
  assert.equal(e.leverage, 50);
  assert.equal(e.takeProfitPct, 500);
  assert.equal(e.managed, true);
  assert.equal(e.creator, ethers.utils.getAddress(other), 'creator checksummed');
});

test('engineFor: the on-chain engine goes through the same validation as the CLI', async (t) => {
  const launch = rc.parseLaunchLog(launchLog());
  await t.test('valid: normalized params, creator = launcher', () => {
    const e = rc.engineFor(launch, rc.parseEngineLog(engineLog()));
    assert.equal(e.ok, true);
    assert.deepEqual(e.params, { market: 'NVDA', side: 'long', leverage: 3, takeProfitPct: 100, managed: false, creator: LAUNCHER });
  });
  await t.test('a launch without its engine event is not served', () => {
    const e = rc.engineFor(launch, null);
    assert.equal(e.ok, false);
    assert.match(e.error, /MultiplyEngine/);
  });
  await t.test('an out-of-range value (should be impossible: the router validates) is rejected, not rounded', () => {
    const e = rc.engineFor(launch, rc.parseEngineLog(engineLog('NVDA', 0, 7, 50)));
    assert.equal(e.ok, false);
    assert.match(e.error, /leverage/);
    const tp = rc.engineFor(launch, rc.parseEngineLog(engineLog('NVDA', 0, 3, 501)));
    assert.equal(tp.ok, false);
    assert.match(tp.error, /take-profit/);
  });
  await t.test('the creator comes from the event, managed is kept', () => {
    const creator = '0x2222222222222222222222222222222222222222';
    const e = rc.engineFor(launch, rc.parseEngineLog(engineLog('NVDA', 0, 25, 200, true, creator)));
    assert.equal(e.ok, true);
    assert.equal(e.params.creator, creator);
    assert.equal(e.params.managed, true);
    assert.equal(e.params.leverage, 25);
  });
  await t.test('unknown enum values decode to null and fail validation', () => {
    const e = rc.engineFor(launch, rc.parseEngineLog(engineLog('NVDA', 5, 3, 50)));
    assert.equal(e.ok, false);
  });
});

test('toCoinRecord: the registry shape, with the sub-wallet derived from the token address', async (t) => {
  const launch = rc.parseLaunchLog(launchLog());
  const engine = rc.engineFor(launch, rc.parseEngineLog(engineLog()));
  const sink = '0x1111111111111111111111111111111111111111';
  const coin = rc.toCoinRecord(launch, engine, sink, { chainName: 'Test 7', chainSymbol: 'TEST7' });
  await t.test('venue, pair and pool are the router defaults', () => {
    assert.equal(coin.venue, 'v4');
    assert.equal(coin.pair, config.USDG);
    assert.equal(coin.pairDecimals, 6);
    assert.equal(coin.poolId, POOL);
    assert.equal(coin.fee, 30_000);
    assert.equal(coin.initialSupply, 1_000_000_000);
    assert.equal(coin.tokenURI, URI);
  });
  await t.test('sink recorded but not adopted yet; engine settings normalized', () => {
    assert.equal(coin.sink, sink);
    assert.equal(coin.sinkAdopted, false);
    assert.deepEqual([coin.market, coin.side, coin.leverage, coin.takeProfitPct, coin.managed], ['NVDA', 'long', 3, 100, false]);
    assert.equal(coin.pendingEngine, null);
    assert.equal(coin.riskProfile, undefined, 'new coins carry no risk profile');
    assert.equal(coin.engineError, null);
  });
  await t.test('the sub-wallet is HMAC(master secret, token address), same as V3', () => {
    assert.equal(coin.subWallet, deriveSubWallet(ASSET).address);
  });
  await t.test('invalid engine: recorded, flagged, no market, never served', () => {
    const bad = rc.toCoinRecord(launch, { ok: false, error: 'invalid leverage 7' }, null, { chainName: 'Test 7', chainSymbol: 'TEST7' });
    assert.equal(bad.market, null);
    assert.equal(bad.leverage, 0);
    assert.equal(bad.takeProfitPct, null);
    assert.equal(bad.sink, null);
    assert.match(bad.engineError, /leverage/);
  });
});

test('scanLaunches: pairs each launch with the engine event of the same asset', async () => {
  const fake = { getLogs: async () => [launchLog(), engineLog('HYPE', 1, 20, 100)] };
  const [l] = await rc.scanLaunches(fake, 1, 1);
  assert.equal(l.token, ASSET);
  assert.deepEqual(l.engine, { token: ASSET, market: 'HYPE', side: 'short', leverage: 20, takeProfitPct: 100, managed: false, creator: LAUNCHER });
  const none = { getLogs: async () => [launchLog()] };
  assert.equal((await none.getLogs()).length, 1);
  assert.equal((await rc.scanLaunches(none, 1, 1))[0].engine, null);
});

test('scanLaunches: queries by address only, and halves the window when the node refuses a span', async (t) => {
  // the live RPC on 2026-10-04: 400k blocks per plain query, 100k with an OR on topic0
  const calls = [];
  const strict = {
    getLogs: async (f) => {
      calls.push(f);
      if (f.topics) throw new Error('topics must not be sent');
      if (f.toBlock - f.fromBlock + 1 > 100_000) {
        const e = new Error('processing response error'); e.body = '{"error":{"message":"query spans 400000 blocks (1 to 400000), but only 100000 are allowed for this request"}}'; throw e;
      }
      return f.fromBlock <= 250_000 && 250_000 <= f.toBlock ? [launchLog(), engineLog('BTC', 0, 2, 20)] : [];
    },
  };
  const found = await rc.scanLaunches(strict, 1, 1_000_000);
  await t.test('the launch in the middle of the range is found, with its engine', () => {
    assert.equal(found.length, 1);
    assert.equal(found[0].engine.market, 'BTC');
  });
  await t.test('every window was contiguous and the whole range was covered exactly once', () => {
    const ok = calls.filter((c) => c.toBlock - c.fromBlock + 1 <= 100_000).sort((a, b) => a.fromBlock - b.fromBlock);
    assert.equal(ok[0].fromBlock, 1);
    assert.equal(ok[ok.length - 1].toBlock, 1_000_000);
    for (let i = 1; i < ok.length; i++) assert.equal(ok[i].fromBlock, ok[i - 1].toBlock + 1);
  });
  await t.test('an error that is not about the span is not swallowed', async () => {
    const down = { getLogs: async () => { throw new Error('missing response'); } };
    await assert.rejects(() => rc.scanLaunches(down, 1, 10), /missing response/);
  });
});

test('a coin is never refused for its name or ticker: only the engine is validated', async (t) => {
  const launch = rc.parseLaunchLog(launchLog());
  const engine = rc.engineFor(launch, rc.parseEngineLog(engineLog()));
  await t.test('a 60-char name with emoji and a lowercase hyphenated ticker are stored as-is, engine ok', () => {
    const name = 'This is a very long meme coin name with an emoji 🚀 and more words';
    const coin = rc.toCoinRecord(launch, engine, null, { chainName: name, chainSymbol: 'test-coin' });
    assert.equal(coin.engineError, null);
    assert.equal(coin.market, 'NVDA');
    assert.equal(coin.name, name);
    assert.equal(coin.symbol, 'test-coin');
  });
});

test('syncRouterCoins: a token whose name() does not answer is retried next tick, not recorded with placeholders', async () => {
  const seen = { names: 0 };
  const provider = {
    getBlockNumber: async () => 63_100_010,
    getLogs: async () => [launchLog(), engineLog()],
    // ethers.Contract needs a provider-ish object: emulate name() failing, symbol() ok, sinkOf() reverting
    call: async (tx) => {
      const sel = String(tx.data).slice(0, 10);
      if (sel === '0x06fdde03') { seen.names++; throw new Error('missing response'); } // name()
      if (sel === '0x95d89b41') return ethers.utils.defaultAbiCoder.encode(['string'], ['TEST7']); // symbol()
      throw new Error('execution reverted');
    },
    resolveName: async (n) => n,
    _isProvider: true,
  };
  const reg = { coins: [], state: {}, routerScanBlock: 63_099_999 };
  const added = await rc.syncRouterCoins(provider, reg, { log: () => {} });
  assert.equal(added, 0, 'nothing recorded');
  assert.equal(reg.coins.length, 0);
  assert.equal(reg.routerScanBlock, 63_099_999, 'cursor stays before the launch block so it is rescanned');
  assert.ok(seen.names >= 1);
});

// ── refreshEngines: the engine as it stands now, every tick ─────────────────
const ZERO = ethers.constants.AddressZero;
const addr = (n) => ethers.utils.getAddress('0x' + String(n).padStart(40, '0'));

/**
 * A provider that answers router.engineOf(asset) from a table: an Error entry makes that one
 * read fail, as an RPC hiccup would. Other calls revert.
 */
function engineProvider(table) {
  return {
    _isProvider: true,
    resolveName: async (n) => n,
    call: async (tx) => {
      const parsed = rc.ROUTER_IFACE.parseTransaction({ data: tx.data });
      if (parsed.name !== 'engineOf') throw new Error('execution reverted');
      const e = table[parsed.args[0].toLowerCase()];
      if (!e) throw new Error('execution reverted');
      if (e instanceof Error) throw e;
      const tuple = [e.market ?? 'NVDA', e.side ?? 0, e.leverage, e.takeProfitPct, e.managed ?? false, e.creator ?? LAUNCHER,
        e.pendingLeverage ?? 0, e.pendingTakeProfitPct ?? 0, e.pendingAt ?? 0];
      return rc.ROUTER_IFACE.encodeFunctionResult('engineOf', [tuple]);
    },
  };
}
const v4coin = (token, over = {}) => ({ venue: 'v4', token, symbol: 'C' + token.slice(-2), market: 'NVDA', side: 'long', leverage: 10, takeProfitPct: 50, managed: true, engineError: null, ...over });

test('refreshEngines: applies changes, records the pending one, ignores what it must not trust', async (t) => {
  await t.test('a changed engine is applied and logged; old tranches keep the leverage they were opened at', async () => {
    const tok = addr(0xa1);
    const reg = { coins: [v4coin(tok)], state: { [tok.toLowerCase()]: { perpTranches: [{ base: 10, entryMark: 1 }, { base: 5, entryMark: 2, leverage: 5 }] } } };
    const logs = [];
    const n = await rc.refreshEngines(engineProvider({ [tok.toLowerCase()]: { leverage: 20, takeProfitPct: 200, managed: true } }), reg, { log: (m) => logs.push(m) });
    assert.equal(n, 1);
    assert.equal(reg.coins[0].leverage, 20);
    assert.equal(reg.coins[0].takeProfitPct, 200);
    assert.equal(reg.coins[0].pendingEngine, null);
    assert.ok(logs.some((m) => m.includes('engine changed: 10x → 20x, +50% → +200%')), logs.join('\n'));
    const tr = reg.state[tok.toLowerCase()].perpTranches;
    assert.equal(tr[0].leverage, 10, 'a tranche without leverage is stamped with the old one');
    assert.equal(tr[1].leverage, 5, 'a tranche with its own leverage is left alone');
  });

  await t.test('an announced change still in its notice is stored as pending, the current engine untouched', async () => {
    const tok = addr(0xa2);
    const reg = { coins: [v4coin(tok)], state: {} };
    const logs = [];
    const at = 1_800_000_000;
    const n = await rc.refreshEngines(engineProvider({ [tok.toLowerCase()]: { leverage: 10, takeProfitPct: 50, pendingLeverage: 3, pendingTakeProfitPct: 300, pendingAt: at } }), reg, { log: (m) => logs.push(m) });
    assert.equal(n, 0);
    assert.equal(logs.length, 0);
    assert.deepEqual(reg.coins[0].pendingEngine, { leverage: 3, takeProfitPct: 300, effectiveAt: at });
    assert.equal(reg.coins[0].leverage, 10);
  });

  await t.test('a value outside the keeper rules is logged once and not applied', async () => {
    const tok = addr(0xa3);
    const reg = { coins: [v4coin(tok)], state: {} };
    const logs = [];
    const p = engineProvider({ [tok.toLowerCase()]: { leverage: 7, takeProfitPct: 50 } });
    await rc.refreshEngines(p, reg, { log: (m) => logs.push(m) });
    await rc.refreshEngines(p, reg, { log: (m) => logs.push(m) });
    assert.equal(reg.coins[0].leverage, 10);
    assert.equal(logs.length, 1, 'reported once, not every tick');
    assert.match(logs[0], /rejected/);
    const tp = { coins: [v4coin(addr(0xa4))], state: {} };
    await rc.refreshEngines(engineProvider({ [addr(0xa4).toLowerCase()]: { leverage: 10, takeProfitPct: 9 } }), tp, { log: () => {} });
    assert.equal(tp.coins[0].takeProfitPct, 50);
  });

  await t.test('zero creator (not launched through this router) is skipped', async () => {
    const tok = addr(0xa5);
    const reg = { coins: [v4coin(tok)], state: {} };
    const n = await rc.refreshEngines(engineProvider({ [tok.toLowerCase()]: { leverage: 2, takeProfitPct: 20, creator: ZERO } }), reg, { log: () => {} });
    assert.equal(n, 0);
    assert.equal(reg.coins[0].leverage, 10);
    assert.equal(reg.coins[0].pendingEngine, undefined, 'record untouched');
  });

  await t.test('one failing read does not stop the others; V3 coins and invalid engines are not read', async () => {
    const bad = addr(0xa6), good = addr(0xa7);
    const reads = [];
    const p = engineProvider({ [bad.toLowerCase()]: new Error('missing response'), [good.toLowerCase()]: { leverage: 50, takeProfitPct: 500 } });
    const call = p.call;
    p.call = async (tx) => { reads.push(rc.ROUTER_IFACE.parseTransaction({ data: tx.data }).args[0]); return call(tx); };
    const reg = { coins: [v4coin(bad), v4coin(good), { token: addr(0xa8), leverage: 3 }, v4coin(addr(0xa9), { engineError: 'x' })], state: {} };
    const logs = [];
    const n = await rc.refreshEngines(p, reg, { log: (m) => logs.push(m) });
    assert.equal(n, 1);
    assert.equal(reg.coins[1].leverage, 50);
    assert.equal(reg.coins[1].takeProfitPct, 500);
    assert.equal(reg.coins[0].leverage, 10);
    assert.ok(logs.some((m) => /not readable/.test(m)));
    assert.deepEqual(reads, [bad, good]);
  });

  await t.test('a legacy record (risk profile, no take-profit) is mapped, not reported as a change', async () => {
    const tok = addr(0xaa);
    const coin = v4coin(tok, { riskProfile: 'degen' });
    delete coin.takeProfitPct;
    const reg = { coins: [coin], state: {} };
    const logs = [];
    const n = await rc.refreshEngines(engineProvider({ [tok.toLowerCase()]: { leverage: 10, takeProfitPct: 100 } }), reg, { log: (m) => logs.push(m) });
    assert.equal(n, 0);
    assert.equal(logs.length, 0);
    assert.equal(coin.takeProfitPct, 100);
  });
});

test('syncRouterCoins: refreshes the engine of known coins on every tick', async () => {
  const tok = addr(0xb1);
  const p = engineProvider({ [tok.toLowerCase()]: { leverage: 25, takeProfitPct: 80 } });
  p.getBlockNumber = async () => 63_100_010;
  p.getLogs = async () => [];
  const reg = { coins: [v4coin(tok, { sink: addr(0xb2) })], state: {}, routerScanBlock: 63_100_010 };
  await rc.syncRouterCoins(p, reg, { log: () => {} });
  assert.equal(reg.coins[0].leverage, 25);
  assert.equal(reg.coins[0].takeProfitPct, 80);
});
