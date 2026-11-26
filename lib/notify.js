const config = require('../config');

/**
 * Tells a Telegram chat what /alerts would say: each problem once when it appears, once more when
 * it is over. Off unless both PERPSPAD_TELEGRAM_BOT_TOKEN and PERPSPAD_TELEGRAM_CHAT_ID are set.
 *
 * Never in the way of the keeper: a message that cannot be sent is tried again at the next round,
 * nothing here throws, and the token never appears in a log line.
 */
const MAX_CHARS = 3500; // Telegram allows 4096 per message

// the same problem with another amount in it (ETH left, dollars in doubt) is not a new one
const keyOf = (p) => `${p.token || ''}|${p.what.replace(/[\d.,]+/g, '#')}`;
const line = (p) => `${p.symbol ? `${p.symbol}: ` : ''}${p.what}`;

function createNotifier({ token = config.TELEGRAM_BOT_TOKEN, chatId = config.TELEGRAM_CHAT_ID, post = globalThis.fetch, log = console.log } = {}) {
  const on = !!(token && chatId && post);
  let told = new Map(); // problem key → the problem, as last told
  let failing = false;

  async function send(text) {
    try {
      const r = await post(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, MAX_CHARS), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`telegram ${r.status}`);
      if (failing) { failing = false; log('  [notify] telegram reachable again'); }
      return true;
    } catch (e) {
      if (!failing) { failing = true; log(`  [notify] not sent (${String(e.message).replace(String(token), '…').slice(0, 80)}), trying again`); }
      return false;
    }
  }

  return {
    on,
    /** once, at start: a keeper that keeps restarting says so */
    async started(what) { if (on) await send(`multiply.cash keeper started${what ? `: ${what}` : ''}`); },
    /** the problems of this round; what changed since the last message is sent */
    async report(problems) {
      if (!on) return;
      const now = new Map(problems.map((p) => [keyOf(p), p]));
      const fresh = [...now.entries()].filter(([k]) => !told.has(k)).map(([, p]) => p);
      const over = [...told.entries()].filter(([k]) => !now.has(k)).map(([, p]) => p);
      if (!fresh.length && !over.length) return;
      const parts = [];
      if (fresh.length) parts.push(`⚠️ ${fresh.length === 1 ? 'Problem' : 'Problems'}\n${fresh.map((p) => `• ${line(p)}`).join('\n')}`);
      if (over.length) parts.push(`✅ Over\n${over.map((p) => `• ${line(p)}`).join('\n')}`);
      // told only when sent: otherwise the same change is tried again next round
      if (await send(parts.join('\n\n'))) told = now;
    },
  };
}

module.exports = { createNotifier };
