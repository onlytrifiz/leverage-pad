/**
 * A short-lived memo for expensive server reads, shared by concurrent callers.
 *
 * A coin page asks for its candles and its feed, and the feed twice (the chart
 * wants the buybacks for its markers, the live feed wants every event). Each
 * one is a scan of the pool's logs; three of them at once on a public RPC took
 * 20 to 30 seconds. Callers within `ttlMs` of each other now share one scan,
 * including the ones that arrive while it is still in flight.
 *
 * Per-process and in memory: on a serverless deploy each instance has its own,
 * which is fine for a cache whose only job is to collapse a burst.
 */
const store = new Map<string, { at: number; value: Promise<unknown> }>();

export function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load().catch((e) => {
    store.delete(key); // a failure is not worth remembering
    throw e;
  });
  store.set(key, { at: Date.now(), value });
  if (store.size > 500) {
    for (const [k, v] of store) if (Date.now() - v.at > ttlMs) store.delete(k);
  }
  return value;
}
