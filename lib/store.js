const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * The registry of a keeper that works on several tokens at once.
 *
 * Every write-ahead in the keeper relies on one thing: what is on disk is what the token had at
 * its last checkpoint. With one token at a time, writing the whole registry was enough. With
 * several, the checkpoint of one would write the others in the middle of what they are doing. So
 * each token is committed on its own, and the file is always made of the last commits.
 *
 * The file keeps its shape: { coins: [...], state: { token: {...} }, ...everything else }.
 */
function createStore(reg, { file = config.REGISTRY_PATH, write = writeAtomic } = {}) {
  const coins = new Map(), states = new Map();
  let rest = {};
  const key = (t) => t.toLowerCase();
  const takeRest = () => {
    // the cursor that says a token has been found is never written without the token
    for (const c of reg.coins) if (!coins.has(key(c.token))) take(key(c.token));
    const { coins: _c, state: _s, ...r } = reg; rest = JSON.stringify(r);
  };
  const take = (k) => {
    const c = reg.coins.find((x) => key(x.token) === k);
    if (c) coins.set(k, JSON.stringify(c));
    if (reg.state[k]) states.set(k, JSON.stringify(reg.state[k]));
  };
  for (const c of reg.coins) take(key(c.token));
  for (const k of Object.keys(reg.state)) if (!states.has(k)) states.set(k, JSON.stringify(reg.state[k]));
  takeRest();

  function flush() {
    const tail = rest === '{}' ? '' : `,\n${rest.slice(1, -1)}`;
    write(file, `{"coins":[\n${[...coins.values()].join(',\n')}\n],"state":{\n${[...states].map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',\n')}\n}${tail}}`);
  }
  return {
    reg,
    /** this token, as it is now, to disk */
    commit(token) { take(key(token)); flush(); },
    /** tokens just added, or whose record the router changed; the state of one at work is left alone */
    commitCoins(isBusy = () => false) { for (const c of reg.coins) { const k = key(c.token); if (!isBusy(k) || !coins.has(k)) take(k); } takeRest(); flush(); },
    /** what belongs to no token */
    commitRest() { takeRest(); flush(); },
    /** the registry as committed: what may be shown outside */
    committed() { return JSON.parse(`{"coins":[${[...coins.values()].join(',')}],"state":{${[...states].map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}${rest === '{}' ? '' : `,${rest.slice(1, -1)}`}}`); },
  };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

module.exports = { createStore };
