/** Redis-shape in-process cache (Map + TTL). */

interface Entry { value: string; expires_at: number | null; }
const store = new Map<string, Entry>();
const counters = { hits: 0, misses: 0, sets: 0, evictions: 0 };

function now(): number { return Date.now(); }
function purge(key: string): void {
  const e = store.get(key);
  if (e && e.expires_at !== null && e.expires_at <= now()) { store.delete(key); counters.evictions++; }
}

export function get(key: string): string | null {
  purge(key);
  const e = store.get(key);
  if (e) { counters.hits++; return e.value; }
  counters.misses++; return null;
}
export function set(key: string, value: string, ttlSeconds: number | null = null): void {
  store.set(key, { value, expires_at: ttlSeconds == null ? null : now() + ttlSeconds * 1000 });
  counters.sets++;
}
export function del(key: string): boolean { return store.delete(key); }
export function expire(key: string, ttlSeconds: number): boolean {
  const e = store.get(key); if (!e) return false;
  e.expires_at = now() + ttlSeconds * 1000; return true;
}
export const json = {
  get<T>(key: string): T | null { const v = get(key); if (v == null) return null; try { return JSON.parse(v) as T; } catch { return null; } },
  set(key: string, value: unknown, ttlSeconds: number | null = null): void { set(key, JSON.stringify(value), ttlSeconds); },
};
export function stats() {
  return { ...counters, keys: store.size, hit_ratio: counters.hits / Math.max(1, counters.hits + counters.misses) };
}
