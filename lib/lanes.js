/**
 * Who works on what. A token is worked on by one lane at a time, whatever asks for it; tokens go
 * side by side, and one that hangs is left to its own timeouts while the round goes on.
 */
function createLanes({ now = Date.now, log = console.log } = {}) {
  const busy = new Map(); // key → since
  return {
    isBusy: (key) => busy.has(key),
    busyFor: (key) => (busy.has(key) ? now() - busy.get(key) : 0),
    /** runs `fn` alone on `key`; false, at once, when somebody already is */
    async run(key, fn) {
      if (busy.has(key)) return false;
      busy.set(key, now());
      try { await fn(); } finally { busy.delete(key); }
      return true;
    },
    /**
     * `work(item)` over the list, `parallel` at a time. An item still at work after `patienceMs` is
     * left behind (its key stays busy until it ends by itself). Never throws.
     */
    async round(items, { key, work, parallel, patienceMs }) {
      const queue = [...items];
      const worker = async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          const k = key(item);
          if (busy.has(k)) continue;
          let timer;
          const done = this.run(k, () => work(item)).catch((e) => log(`  [${k.slice(0, 10)}] ${String(e && e.message).slice(0, 140)}`));
          const late = new Promise((res) => { timer = setTimeout(() => res('late'), patienceMs); });
          if (await Promise.race([done, late]) === 'late') log(`  [${k.slice(0, 10)}] still at work after ${Math.round(patienceMs / 1000)}s: the round goes on without it`);
          clearTimeout(timer);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
    },
  };
}

/** one at a time per name, in order, whatever each of them does */
function createMutex() {
  const tails = new Map(), since = new Map();
  const run = (name, fn) => {
    const prev = tails.get(name) || Promise.resolve();
    const mine = async () => { since.set(name, Date.now()); try { return await fn(); } finally { since.delete(name); } };
    const next = prev.then(mine, mine);
    const tail = next.then(() => {}, () => {});
    tails.set(name, tail);
    tail.then(() => { if (tails.get(name) === tail) tails.delete(name); });
    return next;
  };
  /** how long whoever is in has been in */
  run.heldFor = (name) => (since.has(name) ? Date.now() - since.get(name) : 0);
  return run;
}

/**
 * At most `n` at once; `front` goes before those who wait without it, and `reserved` of the places
 * are theirs alone: however slow the others are, there is one for what cannot wait.
 */
function createSemaphore(n, { reserved = 0 } = {}) {
  let at = 0;
  const first = [], then = [];
  const pump = () => {
    while (first.length && at < n) { at++; first.shift()(); }
    while (!first.length && then.length && at < n - reserved) { at++; then.shift()(); }
  };
  return async (fn, { front = false } = {}) => {
    await new Promise((res) => { (front ? first : then).push(res); pump(); });
    try { return await fn(); } finally { at--; pump(); }
  };
}

module.exports = { createLanes, createMutex, createSemaphore };
