const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PERPSPAD_MASTER_SECRET = process.env.PERPSPAD_MASTER_SECRET || 'test-secret-for-dry-tests';
const { lockHolderAlive } = require('../keeper');
const { parseSeed, applySeed } = require('../lib/stateSeed');
const { handler } = require('../lib/publicServer');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-state-'));
const seedOf = (files) => Buffer.from(JSON.stringify({ files })).toString('base64');

test('lockHolderAlive: a lock from a previous container never blocks the new one', async (t) => {
  const alive = () => {}; // kill(pid, 0) succeeds: some process with that pid exists here
  await t.test('same host, other live pid: alive', () => {
    assert.equal(lockHolderAlive({ pid: 7, host: 'a' }, { pid: 9, host: 'a', kill: alive }), true);
  });
  await t.test('other host (redeployed container on the same volume): stale even if the pid exists here', () => {
    assert.equal(lockHolderAlive({ pid: 7, host: 'old-container' }, { pid: 9, host: 'new-container', kill: alive }), false);
  });
  await t.test('our own pid (PIDs restart in every container): stale', () => {
    assert.equal(lockHolderAlive({ pid: 7, host: 'a' }, { pid: 7, host: 'a', kill: alive }), false);
  });
  await t.test('legacy lock without host: decided by the pid as before', () => {
    const dead = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
    const other = () => { const e = new Error('not permitted'); e.code = 'EPERM'; throw e; };
    assert.equal(lockHolderAlive({ pid: 7 }, { pid: 9, host: 'a', kill: dead }), false);
    assert.equal(lockHolderAlive({ pid: 7 }, { pid: 9, host: 'a', kill: other }), true);
  });
  await t.test('corrupt or empty lock: stale', () => {
    assert.equal(lockHolderAlive(null, { pid: 9, host: 'a', kill: alive }), false);
    assert.equal(lockHolderAlive({ pid: 'x' }, { pid: 9, host: 'a', kill: alive }), false);
  });
});

test('applySeed: creates missing state files, never overwrites the volume', async (t) => {
  const reg = JSON.stringify({ coins: [{ token: '0x1' }], state: {} });
  const fp = JSON.stringify({ fingerprint: '0xabc' });
  await t.test('empty volume: both files written', () => {
    const dir = tmpdir();
    const r = applySeed(seedOf({ 'registry.json': reg, 'fingerprint.json': fp }), dir, () => {});
    assert.deepEqual(r.written.sort(), ['fingerprint.json', 'registry.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'), reg);
  });
  await t.test('a registry already on the volume is kept: a stale seed cannot roll the accounting back', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'registry.json'), '{"coins":[],"state":{},"newer":true}');
    const r = applySeed(seedOf({ 'registry.json': reg }), dir, () => {});
    assert.deepEqual(r.skipped, ['registry.json']);
    assert.match(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'), /newer/);
  });
  await t.test('no seed: nothing happens', () => {
    assert.deepEqual(applySeed(undefined, tmpdir(), () => {}), { written: [], skipped: [] });
  });
  await t.test('only the two state files, by plain name, with valid JSON', () => {
    assert.throws(() => parseSeed(seedOf({ '../../etc/passwd': '{}' })), /not a seedable/);
    assert.throws(() => parseSeed(seedOf({ 'keeper.lock': '{}' })), /not a seedable/);
    assert.throws(() => parseSeed(seedOf({ 'registry.json': '{broken' })));
    assert.throws(() => parseSeed(Buffer.from('{"nofiles":1}').toString('base64')), /expected/);
  });
});

test('publicServer handler: serves the snapshot and nothing else', async (t) => {
  const dir = tmpdir();
  const file = path.join(dir, 'public.json');
  const call = (method, url) => {
    const res = { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b || ''; } };
    handler({ method, url }, res, file);
    return res;
  };
  await t.test('before the first tick: 503', () => {
    assert.equal(call('GET', '/public.json').status, 503);
  });
  await t.test('the snapshot, with CORS for the site', () => {
    fs.writeFileSync(file, '{"coins":[],"state":{}}');
    const r = call('GET', '/public.json?x=1');
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"coins":[],"state":{}}');
    assert.equal(r.headers['access-control-allow-origin'], '*');
  });
  await t.test('health reports the snapshot age', () => {
    const r = call('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
  });
  await t.test('no other path, no writes', () => {
    assert.equal(call('GET', '/registry.json').status, 404);
    assert.equal(call('GET', '/../registry.json').status, 404);
    assert.equal(call('POST', '/public.json').status, 405);
  });
});
