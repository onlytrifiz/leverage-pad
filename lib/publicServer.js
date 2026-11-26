const http = require('http');
const fs = require('fs');
const { SNAPSHOT_PATH, HEALTH_PATH } = require('./publish');

/**
 * publicServer.js — serves the keeper's public snapshot to the site.
 *
 * The site runs on Vercel and cannot read the keeper's volume, so the keeper exposes the one
 * file that is meant to be public: state/public.json, built from a whitelist by lib/publish.js
 * (no API keys, no internal state). Read-only, GET only, two paths. Started only when the
 * platform hands us a PORT (Railway does); locally nothing listens.
 *
 *   GET /public.json  the snapshot, or 503 until the first tick has written it
 *   GET /health       200 with the snapshot's age, for the platform's health check
 *   GET /alerts       200 when all is well, 503 with what is wrong: for an uptime monitor
 */

const STALE_MS = 10 * 60_000; // a round takes seconds, a long one minutes: this long without one is a keeper that stopped

function snapshotAgeMs(file = SNAPSHOT_PATH) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return null; }
}

function handler(req, res, file = SNAPSHOT_PATH, healthFile = HEALTH_PATH) {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, {
      'content-type': type,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=5',
    });
    res.end(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, '{"error":"method not allowed"}');
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') return send(200, JSON.stringify({ ok: true, snapshotAgeMs: snapshotAgeMs(file) }));
  if (url === '/alerts') {
    const age = snapshotAgeMs(file);
    let problems = [];
    try { problems = JSON.parse(fs.readFileSync(healthFile, 'utf8')).problems ?? []; } catch { /* none yet */ }
    if (age == null || age > STALE_MS) problems = [{ what: age == null ? 'no snapshot' : `no round for ${Math.round(age / 60_000)} minutes` }, ...problems];
    return send(problems.length ? 503 : 200, JSON.stringify({ ok: problems.length === 0, snapshotAgeMs: age, problems }));
  }
  if (url === '/public.json') {
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { return send(503, '{"error":"no snapshot yet"}'); }
    return send(200, body);
  }
  return send(404, '{"error":"not found"}');
}

function startPublicServer(port = process.env.PORT, log = console.log) {
  if (!port) return null;
  const server = http.createServer((req, res) => handler(req, res));
  server.listen(Number(port), '0.0.0.0', () => log(`public snapshot served on :${port}/public.json`));
  return server;
}

module.exports = { handler, startPublicServer, snapshotAgeMs };
