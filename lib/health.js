const config = require('../config');

/**
 * What a person should be told about, from the state after a round.
 *
 * /health only says the process is up; this says whether the money moves. Each check is a
 * condition that is normal for a while (a withdrawal on the bridge, an order waiting for its
 * fills) and a problem only when it lasts: dated by the state's own timestamps where it has them,
 * so a keeper that keeps restarting does not hide them, and from when it was first seen otherwise.
 */
const LIMITS = {
  order: 15 * 60_000,         // an order not settled on its trades
  transfer: 30 * 60_000,      // a signed transfer not confirmed
  withdrawal: 3 * 3600_000,   // a Lighter withdrawal not arrived (the bridge has taken 8 to 30 minutes)
  stale: 30 * 60_000,         // a token no round has been to
  feed: 5 * 60_000,           // the live marks lost
};

function createHealth({ now = Date.now } = {}) {
  const since = new Map(); // condition → when it was first seen, while it holds
  const lasting = (key, holds, limit, from = null) => {
    if (!holds) { since.delete(key); return false; }
    if (!since.has(key)) since.set(key, now());
    const start = Number(from) > 0 ? Math.min(Number(from), since.get(key)) : since.get(key);
    return now() - start >= limit;
  };

  /** problems: [{ token, symbol, what }], empty when all is well */
  function check({ reg, feedWanted = false, feedLive = true, gasEth = null }) {
    const problems = [], seen = new Set();
    const say = (what, coin) => problems.push({ ...(coin ? { token: coin.token, symbol: coin.symbol } : {}), what });
    for (const coin of reg.coins || []) {
      const k = coin.token.toLowerCase(), st = (reg.state || {})[k];
      if (!st || config.PAUSED.has(k)) continue;
      const key = (what) => { const s = `${k}:${what}`; seen.add(s); return s; };
      if (lasting(key('order'), !!st.perpOrder, LIMITS.order, st.perpOrder && st.perpOrder.at)) say('an order on Lighter has not settled for 15 minutes', coin);
      if (lasting(key('transfer'), !!st.txOut, LIMITS.transfer, st.txOut && st.txOut.at)) say('a transfer has not confirmed for 30 minutes', coin);
      if (lasting(key('withdrawal'), Number(st.perpWithdrawPendingUsd || 0) > 0 || Number(st.perpWithdrawIntentUsd || 0) > 0, LIMITS.withdrawal, st.perpWithdrawAt))
        say('a Lighter withdrawal has not arrived in 3 hours', coin);
      if (Number(st.perpDoubtUsd || 0) > 0) say(`$${Number(st.perpDoubtUsd).toFixed(2)} withdrawn without an answer from Lighter`, coin);
      if (now() - Number(st.lastTickTs || 0) >= LIMITS.stale) say('not looked at for 30 minutes', coin);
    }
    for (const s of since.keys()) if (s.includes(':') && !seen.has(s)) since.delete(s);
    if (lasting('feed', feedWanted && !feedLive, LIMITS.feed)) say('live prices lost for 5 minutes: take-profits wait for the routine looks');
    if (gasEth != null && gasEth < config.ALERT_MIN_ETH) say(`the keeper wallet has ${gasEth.toFixed(5)} ETH left for gas`);
    return { at: now(), problems };
  }
  return { check };
}

module.exports = { createHealth, LIMITS };
