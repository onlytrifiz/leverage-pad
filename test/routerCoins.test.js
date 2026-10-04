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
function engineLog(market = 'NVDA', side = 0, leverage = 3, risk = 2) {
  const ev = rc.ROUTER_IFACE.getEvent('MultiplyEngine');
  const { data, topics } = rc.ROUTER_IFACE.encodeEventLog(ev, [ASSET, market, side, leverage, risk]);
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

test('parseEngineLog: enums decoded to the words the keeper uses', () => {
  assert.deepEqual(rc.parseEngineLog(engineLog('TSLA', 1, 5, 1)), { token: ASSET, market: 'TSLA', side: 'short', leverage: 5, risk: 'balanced' });
  assert.deepEqual(rc.parseEngineLog(engineLog('BTC', 0, 2, 0)).risk, 'safe');
  assert.equal(rc.parseEngineLog(engineLog('BTC', 0, 2, 2)).risk, 'degen');
});

test('engineFor: the on-chain engine goes through the same validation as the CLI', async (t) => {
  const launch = rc.parseLaunchLog(launchLog());
  await t.test('valid: normalized params, creator = launcher', () => {
    const e = rc.engineFor(launch, rc.parseEngineLog(engineLog()));
    assert.equal(e.ok, true);
    assert.deepEqual(e.params, { market: 'NVDA', side: 'long', leverage: 3, riskProfile: 'degen', creator: LAUNCHER });
  });
  await t.test('a launch without its engine event is not served', () => {
    const e = rc.engineFor(launch, null);
    assert.equal(e.ok, false);
    assert.match(e.error, /MultiplyEngine/);
  });
  await t.test('an out-of-range value (should be impossible: the router validates) is rejected, not rounded', () => {
    const e = rc.engineFor(launch, rc.parseEngineLog(engineLog('NVDA', 0, 7, 1)));
    assert.equal(e.ok, false);
    assert.match(e.error, /leva/);
  });
  await t.test('unknown enum values decode to null and fail validation', () => {
    const e = rc.engineFor(launch, rc.parseEngineLog(engineLog('NVDA', 5, 3, 1)));
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
    assert.deepEqual([coin.market, coin.side, coin.leverage, coin.riskProfile], ['NVDA', 'long', 3, 'degen']);
    assert.equal(coin.engineError, null);
  });
  await t.test('the sub-wallet is HMAC(master secret, token address), same as V3', () => {
    assert.equal(coin.subWallet, deriveSubWallet(ASSET).address);
  });
  await t.test('invalid engine: recorded, flagged, no market, never served', () => {
    const bad = rc.toCoinRecord(launch, { ok: false, error: 'leva non valida' }, null, { chainName: 'Test 7', chainSymbol: 'TEST7' });
    assert.equal(bad.market, null);
    assert.equal(bad.leverage, 0);
    assert.equal(bad.sink, null);
    assert.match(bad.engineError, /leva/);
  });
});

test('scanLaunches: pairs each launch with the engine event of the same asset', async () => {
  const fake = { getLogs: async () => [launchLog(), engineLog('HYPE', 1, 20, 2)] };
  const [l] = await rc.scanLaunches(fake, 1, 1);
  assert.equal(l.token, ASSET);
  assert.deepEqual(l.engine, { token: ASSET, market: 'HYPE', side: 'short', leverage: 20, risk: 'degen' });
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
      return f.fromBlock <= 250_000 && 250_000 <= f.toBlock ? [launchLog(), engineLog('BTC', 0, 2, 0)] : [];
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
