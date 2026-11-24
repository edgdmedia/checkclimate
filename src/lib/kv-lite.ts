/**
 * A tiny TTL store for the two things that were platform bindings.
 *
 * On Workers, search was limited by a `ratelimits` binding and the weather
 * reading was kept in the Cache API. Both are per-visitor-keyed counters that
 * only need to survive a few minutes, and this deployment is exactly one
 * long-lived process (SQLite has a single writer, and EmDash's scheduler must
 * not run twice), so a Map is the honest replacement.
 *
 * Entries are dropped on the hour, so the two Maps cannot grow without bound
 * even if a crawler invents a new key per request.
 */
type Entry = { value: string; at: number; ttl: number };

const store = new Map<string, Entry>();
const hits = new Map<string, number[]>();

/** The limiter's window, and the cleanup interval. */
const WINDOW_MS = 60_000;

let swept = Date.now();
function sweep(): void {
	const now = Date.now();
	if (now - swept < WINDOW_MS) return;
	swept = now;
	for (const [key, entry] of store) {
		if (now - entry.at > entry.ttl) store.delete(key);
	}
	for (const [key, times] of hits) {
		const fresh = times.filter((at) => now - at < WINDOW_MS);
		if (fresh.length) hits.set(key, fresh);
		else hits.delete(key);
	}
}

export function cacheGet(key: string): string | null {
	sweep();
	const entry = store.get(key);
	if (!entry) return null;
	if (Date.now() - entry.at > entry.ttl) {
		store.delete(key);
		return null;
	}
	return entry.value;
}

export function cacheSet(key: string, value: string, ttlSeconds: number): void {
	store.set(key, { value, at: Date.now(), ttl: ttlSeconds * 1000 });
}

/**
 * True when this key has stayed under `limit` calls in the last minute.
 *
 * Callers fail open: like the Workers binding, a limiter that cannot decide
 * must not lock a reader out of search.
 */
export function allow(key: string, limit: number): boolean {
	sweep();
	const now = Date.now();
	const times = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
	times.push(now);
	hits.set(key, times);
	return times.length <= limit;
}

/** For the runbook's "is the cache warm" check and for tests. */
export function stats(): { cached: number; tracked: number } {
	return { cached: store.size, tracked: hits.size };
}

/** Tests only. */
export function reset(): void {
	store.clear();
	hits.clear();
	swept = Date.now();
}
