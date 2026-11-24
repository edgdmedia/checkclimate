# Check Climate Africa — Workers → VPS migration plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move checkclimate.africa off Cloudflare Workers Free (Worker + Hyperdrive + Neon + KV) onto the shared edgdmedia VPS — Astro + EmDash on Node 24 with a SQLite file, media still in R2, Cloudflare still the edge cache.

**Architecture:** Browser → Cloudflare (proxied DNS, Cache Rule, purge by `Cache-Tag`) → nginx on `169.58.2.239` (origin cert, Cloudflare-only) → `127.0.0.1:4331` one Node process (systemd, user `checkclimate`) → `/home/checkclimate/data/emdash.db` (WAL); media over R2's S3 API into the existing `checkclimate-media` bucket; sessions in `/home/checkclimate/data/sessions`; nightly `sqlite3 .backup` off-box to a private R2 bucket.

**Tech Stack:** Astro 7.3, EmDash 1.5, `@astrojs/node` (standalone), `node:sqlite` via `emdash/db`, `emdash/astro` `s3()` + `memoryCache()`, sharp + opentype.js (image transforms and share cards), R2, Cloudflare zone cache, GitHub Actions over SSH.

**Decisions already taken (owner, 2026-11-24):** SQLite on the box; the shared edgdmedia box; runbook-and-owner-runs-it for server steps; no quota audit before starting.

## Why the quota forces this

The free plan caps are what bite here, and every one of them is per *account* (Security Focus, shared with other projects):

- 10 ms CPU per request — one uncached render is ~1.3 ms middleware + 314 ms of DB wait across 28 queries; a burst of cache misses is an 1102.
- The `*/15 * * * *` cron is 96 Worker invocations a day doing DB reads on a cold Neon, forever, for a site that does not need 15-minute publishing granularity.
- Hyperdrive 100k queries/day and Neon ~191.9 compute-hours/month, with the compute parking after 5 idle minutes.
- KV 1,000 writes/day.

On the box, reads are free and there is one warm process, so all four stop being a constraint. `docs/RUNBOOK.md` and `docs/PLAN.md` are re-targeted by Task 1.

## Inputs the owner must supply

| Input | Where it goes |
|---|---|
| Virtualmin site/user `checkclimate` on `169.58.2.239` (or root does it) | every file in `deploy/` |
| Zone id of `checkclimate.africa` (Security Focus account) | `/etc/checkclimate.env`, `CLOUDFLARE_ZONE_ID` |
| R2 API token, Object Read & Write, scoped to `checkclimate-media` | `/etc/checkclimate.env`, `S3_*` |
| Cloudflare token with Zone → Cache Purge | `/etc/checkclimate.env` + repo secret `CLOUDFLARE_PURGE_TOKEN` |
| A free port on the box (4331 assumed; `ss -ltnp` proves it) | `deploy/*` |
| SSH public key installed for the `checkclimate` user | laptop + GitHub secret |

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `AGENTS.md`, `docs/PLAN.md` | modify | the rules say VPS, not Workers |
| `astro.config.mjs` | rewrite | node adapter, sqlite, s3, memoryCache, sessions, trustedProxyHeaders; **no** `cache`/`routeRules` |
| `package.json` | modify | deps in, deps out, `deploy:*` scripts |
| `src/runtime.ts` | create | one place that reads the process environment (replaces `cloudflare:workers`) |
| `src/worker.ts` | delete | the Worker entry point is gone |
| `src/env.d.ts` | rewrite | no bindings; `astro:env`-free plain types |
| `src/lib/cache-tags.ts` | create | path → `Cache-Tag` groups |
| `src/lib/kv-lite.ts` | create | tiny TTL Map: weather cache + search limiter |
| `src/middleware.ts` | modify | drop `env` import, use `src/lib/kv-lite.ts`, add cache-header policy |
| `src/pages/api/weather.ts` | create | the weather endpoint, moved out of `worker.ts` |
| `plugins/cloudflare-purge/` | create | purge by tag on publish/unpublish/delete/restore/live-save |
| `plugins/resend-email/src/env.mjs` | modify | process env instead of `cloudflare:workers` |
| `src/utils/{email,site,claims,turnstile}.ts` | modify | read config through `src/runtime.ts` |
| `src/utils/media-store.ts` | create | storage get/put/delete for `claims/` and `share/` keys |
| `share/fonts/*.ttf`, `share/fonts/OFL.txt` | create | Red Hat Display 500/700/900 for the share renderer |
| `src/utils/share-render.ts` | create | DrawOps → PNG (sharp composite + opentype.js text paths) |
| `src/pages/share/[format]/[slug].png.ts` | rewrite | same routes/keys, new renderer |
| `src/pages/search/index.astro`, `src/utils/search.ts` | modify | SQLite FTS via EmDash `search()` |
| `src/{components/Archive,layouts/Base,pages/index,pages/[yyyy]/[mm]/[dd]/[slug]}.astro` | modify | remove 16 `Astro.cache.set` sites |
| `scripts/pg-to-sqlite.mjs` | create | the site-package copy: export → import → verify |
| `scripts/verify-migration.ts` | modify | `--database=sqlite` |
| `deploy/nginx-proxy.conf`, `checkclimate.service`, `sudoers-checkclimate`, `checkclimate.env.example`, `checkclimate.build.env.example`, `cloudflare-ips.txt` | create | the box |
| `scripts/deploy-vps.sh`, `scripts/backup-vps.sh` | create | deploy + nightly backup |
| `.github/workflows/{ci,deploy}.yml` | modify | build/ship to the box, purge the edge after each deploy |
| `docs/vps-runbook.md` | create | the owner's manual, one command per line |
| `docs/RUNBOOK.md`, `docs/STATUS.md` | modify | rewritten to the new shape |

---

## Phase A — Branch and ground rules

### Task 1: Branch `vps` and re-target the docs

**Files:** modify `AGENTS.md`, `docs/PLAN.md`; create this plan's sibling note in `docs/STATUS.md` (deferred to Task 22).

- [ ] **Step 1: confirm the tree is clean and branch**

```bash
cd /Users/olalekan/Projects/checkclimate
git status --short
git switch -c vps dev
git branch --show-current
```

Expected: `vps`. If `git status` shows ` wrangler.jsonc` modified, leave it: the `MEDIA remote: true` line is a deliberate uncommitted import leftover — verify with `grep -n '"remote"' wrangler.jsonc` and report what you find before touching it.

- [ ] **Step 2: replace the hard rules in `AGENTS.md`**

Swap the two Workers rules for:

```markdown
- **Target: the shared edgdmedia VPS (`169.58.2.239`).** Astro + EmDash on Node 24
  with `@astrojs/node` (`mode: "standalone"`), SQLite through `sqlite()` from
  `emdash/db`, media in R2 through `s3()`, one process under systemd behind
  nginx, Cloudflare as the edge cache. **No Workers adapter, no Hyperdrive, no
  Neon, no KV, no cron trigger** in the shipped config — the Workers build stays
  reachable on `main` as the rollback until the owner says the box is final.
- **Cache with HTTP headers, not Astro's cache provider.** Middleware sets
  `Cache-Control` + `Cache-Tag`; `plugins/cloudflare-purge` purges by tag; the
  zone Cache Rule makes HTML cacheable. **Never configure an Astro `cache`
  provider or `routeRules` on this branch**: with a provider, EmDash skips its
  own query cache (14 queries per home render instead of 1) and Astro strips
  `Cache-Tag`.
```

- [ ] **Step 3: delete the now-false Workers rules**

In `AGENTS.md` remove: the "10 ms CPU per request" rule, the `MEDIA`/R2-binding rule (replaced by `s3()` above), the KV writes rule, the `astro build && wrangler deploy` rule, and the "Read these before coding" line that points at `deploying-emdash-cloudflare/SKILL.md` **only** — keep `vps.md`, add `neon-hyperdrive.md` is dropped, and note the site-transfer guide.

- [ ] **Step 4: re-target `docs/PLAN.md`**

Header line 3 becomes:

```markdown
Status: plan v3, 2026-11-24. Stack moved from Cloudflare Workers (free) to the
shared edgdmedia **VPS: Node + SQLite behind Cloudflare, media still in R2**.
Reason: the free account quotas (10 ms CPU/request, 100k requests, Hyperdrive
100k queries, Neon compute hours, KV 1,000 writes) are nearly spent for
November. Worker stays up as the rollback.
```

Replace the Architecture block with the VPS shape from this plan's header, replace the "Free-plan limits" table with a short "What the box costs" note (nothing per read), and set the phase table rows 5–10 to `superseded by docs/superpowers/plans/2026-11-24-vps-migration.md`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/PLAN.md docs/superpowers/plans/2026-11-24-vps-migration.md
git commit -m "Re-target the build at the VPS: Node + SQLite, R2 media, edge cache"
```

---

## Phase B — Config and runtime

### Task 2: Dependencies

**Files:** modify `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: add what Node needs**

```bash
pnpm add @astrojs/node sharp @aws-sdk/client-s3 @aws-sdk/s3-request-presigner opentype.js
pnpm add -D @types/opentype.js
```

Expected: four+one deps installed, `pnpm-lock.yaml` updated. `sharp` is required because EmDash delegates transforms to `astro:assets`, whose Node service is sharp-based (`node_modules/emdash/dist/media/image-endpoint.mjs` says so in its header comment).

- [ ] **Step 2: drop what only the Worker needed**

```bash
pnpm remove @astrojs/cloudflare @emdash-cms/cloudflare pg @cloudflare/workers-types @types/pg
```

Expected: removed. If `scripts/migration-db.ts` or another file still imports `pg`, leave the removal staged and fix imports in Task 15 before re-running `pnpm remove`.

- [ ] **Step 3: scripts in `package.json`**

Replace the two `deploy:*` lines and add the box ones:

```json
    "build:vps": "node scripts/build-tokens.mjs && astro build",
    "start": "node ./dist/server/entry.mjs",
    "deploy:staging": "EMDASH_SITE_URL=https://vps.checkclimate.africa DATABASE_PATH=/home/checkclimate/data/emdash.db SESSION_DIR=/home/checkclimate/data/sessions S3_BUCKET=checkclimate-media pnpm build:vps",
    "deploy:production": "EMDASH_SITE_URL=https://checkclimate.africa DATABASE_PATH=/home/checkclimate/data/emdash.db SESSION_DIR=/home/checkclimate/data/sessions S3_BUCKET=checkclimate-media pnpm build:vps",
```

Keep `dev`, `preview`, `typecheck`, `test`, `seed*`, `doctor`, `types`, `post-import`, `unwrap-wayback`, `verify-migration`.

- [ ] **Step 4: `.gitignore` for box artifacts**

Append:

```
data/*.db
data/*.db-wal
data/*.db-shm
data/sessions/
data/backups/
```

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore
git commit -m "Swap Workers runtime deps for Node, SQLite, S3 and sharp"
```

### Task 3: `src/runtime.ts` — one reader of the environment

**Files:** create `src/runtime.ts`

Every module that currently does `import { env } from "cloudflare:workers"` reads config through this instead, so there is exactly one runtime coupling to replace.

- [ ] **Step 1: write it**

```ts
/**
 * Runtime configuration, read once from the process environment.
 *
 * On the box these come from /etc/checkclimate.env (systemd `EnvironmentFile`);
 * in `astro dev` from `.env` (Astro loads it) or the shell. Nothing here may
 * hold a Workers binding: this file is the only place the app looks for
 * environment values.
 */
const str = (key: string, fallback = ""): string => {
	const value = process.env[key];
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const int = (key: string, fallback: number): number => {
	const value = Number(process.env[key]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const runtime = {
	/** The public origin this process was built for (canonical URLs). */
	siteUrl: str("EMDASH_SITE_URL", "https://checkclimate.africa"),
	/** Transactional mail. */
	resendApiKey: str("RESEND_API_KEY"),
	emailFrom: str("EMAIL_FROM"),
	/** Operator override for where new claims are emailed. */
	claimsInbox: str("CLAIMS_INBOX"),
	/** Turnstile; empty means the forms do not check (EmDash's own rule). */
	turnstileSiteKey: str("TURNSTILE_SITE_KEY", str("EMDASH_TURNSTILE_SITE_KEY")),
	turnstileSecretKey: str("TURNSTILE_SECRET_KEY", str("EMDASH_TURNSTILE_SECRET_KEY")),
	/** Cloudflare zone cache purge (plugins/cloudflare-purge). */
	cloudflareZoneId: str("CLOUDFLARE_ZONE_ID"),
	cloudflareApiToken: str("CLOUDFLARE_API_TOKEN"),
	purgeEnabled: str("CLOUDFLARE_PURGE_ENABLED", "1") !== "0",
	/** HTTP listener. */
	port: int("PORT", 4331),
	host: str("HOST", "127.0.0.1"),
};

/** Absolute origin for building URLs when Astro's `site` is unavailable. */
export function origin(): string {
	try {
		return new URL(runtime.siteUrl).origin;
	} catch {
		return "https://checkclimate.africa";
	}
}
```

- [ ] **Step 2: typecheck** (it will fail on the not-yet-deleted Worker files — expected)

```bash
pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/runtime.ts
git commit -m "Read runtime config from the process environment in one module"
```

### Task 4: Rewrite `astro.config.mjs` for Node

**Files:** modify `astro.config.mjs`

- [ ] **Step 1: the imports and the top block**

Replace lines 1–23 with:

```js
import node from "@astrojs/node";
import react from "@astrojs/react";
import emdash, { local, memoryCache, s3 } from "emdash/astro";
import { sqlite } from "emdash/db";
import { defineConfig, sessionDrivers } from "astro/config";
import { fileURLToPath } from "node:url";
import { Features } from "lightningcss";

// The SQLite file lives on the box, not in the checkout. The path is baked at
// BUILD time (EmDash reads it in the config), so scripts/deploy-vps.sh sources
// /etc/checkclimate.build.env before `astro build` as well.
const databasePath = process.env.DATABASE_PATH ?? "./data/emdash.db";
const sessionDir = process.env.SESSION_DIR ?? "./.astro/sessions";

// Media stays in the same R2 bucket, reached over its S3 API. Without
// S3_BUCKET (laptop, CI) the site falls back to local disk so `pnpm dev`
// needs no cloud credentials. EMDASH_STORAGE=s3|local forces either.
const storageDriver = process.env.EMDASH_STORAGE ?? (process.env.S3_BUCKET ? "s3" : "local");
const storage =
	storageDriver === "s3"
		? s3()
		: local({ directory: "./data/uploads", baseUrl: "/_emdash/api/media/file" });

const siteUrl = process.env.EMDASH_SITE_URL || "https://checkclimate.africa";

// A build is always for the box: refuse to bake a localhost origin into it.
if (process.argv.includes("build") && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(siteUrl)) {
	throw new Error(
		`EMDASH_SITE_URL is ${siteUrl} for a production build. Run \`pnpm deploy:production\`, or set EMDASH_SITE_URL.`,
	);
}
```

- [ ] **Step 2: delete the `cachedPage` helper and the whole `routeRules` block**

Keep the comment that explains why there is no Astro cache provider, and replace the block with:

```js
// No `cache:` and no `routeRules` on purpose.
//   - With an Astro cache provider configured, EmDash skips its own query
//     cache, so a home render goes from 1 DB pass to ~14.
//   - Astro strips `Cache-Tag` from a page its provider serves, and
//     `Cache-Tag` is how a publish purges the edge.
// Caching is HTTP headers in src/middleware.ts plus the zone Cache Rule
// (docs/vps-runbook.md). The in-process query cache below is the real
// database-saver.
```

- [ ] **Step 3: the config body**

```js
export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	trailingSlash: "ignore",
	site: siteUrl,
	image: { layout: "constrained", responsiveStyles: true },
	// Admin sign-ins survive a deploy only if the store is outside the app
	// directory: a deploy replaces the checkout.
	session: { driver: sessionDrivers.fsLite({ base: sessionDir }) },
	vite: {
		resolve: { alias: localPluginAliases },
		css: { lightningcss: { exclude: Features.LightDark } },
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${databasePath}` }),
			storage,
			// One warm process, so this is a real cross-request cache. `revalidate:
			// 0`: EmDash invalidates on write, and a stale read never costs
			// correctness because the edge is purged at the same time.
			objectCache: memoryCache({ defaultTtl: 3600, revalidate: 0, maxEntries: 5000 }),
			// nginx forwards CF-Connecting-IP and X-Forwarded-For; trusting them is
			// safe only because nginx answers 403 to anything not from Cloudflare.
			trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"],
			plugins: [...localPlugins, cloudflarePurge()],
			siteUrl,
			toolbar: "client",
			admin: { logo: "/brand/admin-mark.png", siteName: "Check Climate", favicon: "/favicon.ico" },
		}),
	],
	devToolbar: { enabled: false },
});
```

Notes to honour while editing:
- Drop `ssr.noExternal`, `environments.ssr.resolve.noExternal` and `optimizeDeps.include: ["pg"]` — they existed only to make `pg` work under workerd. If the build then complains about an externalised package, add that package back to `noExternal` specifically.
- Import the purge descriptor at the top: `import { cloudflarePurge } from "@checkclimate/plugin-cloudflare-purge";` and add the alias pair in `localPluginSources` (Task 9 creates the plugin; land Task 9 before this step, or stage this change until then).
- `predev`/`prebuild` (`scripts/build-tokens.mjs`) are untouched.

- [ ] **Step 4: verify the config parses and the plugin list resolves**

```bash
node --input-type=module -e "const c=(await import('./astro.config.mjs')).default; console.log(c.adapter?.name ?? 'adapter-set', !!c.cache, Object.keys(c.routeRules ?? {}))"
```

Expected: prints an adapter, `false` for cache, `[]` for routeRules.

- [ ] **Step 5: Commit**

```bash
git add astro.config.mjs
git commit -m "Run Astro on Node with SQLite, R2 over S3 and the in-process query cache"
```

---

## Phase C — Cut the Workers coupling

### Task 5: `src/lib/kv-lite.ts` and `src/lib/cache-tags.ts`

**Files:** create `src/lib/kv-lite.ts`, `src/lib/cache-tags.ts`

- [ ] **Step 1: the TTL store (weather cache + search limiter)**

The Worker had two stateful bindings: the Cache API for weather and a rate
limiter for search. One process, so both are a `Map`.

```ts
/**
 * A tiny TTL map: the two things on Workers were bindings with state
 * (`caches.default` for weather, `ratelimits` for search). One long-lived
 * process, so a Map is the honest replacement — and it is why exactly one
 * Node process may run.
 */
type Entry = { value: string; at: number; ttl: number };
const store = new Map<string, Entry>();
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

let swept = Date.now();
function sweep(): void {
	const now = Date.now();
	if (now - swept < 60_000) return;
	swept = now;
	for (const [key, entry] of store) if (now - entry.at > entry.ttl) store.delete(key);
	for (const [key, times] of hits) {
		const fresh = times.filter((at) => now - at < WINDOW_MS);
		if (fresh.length) hits.set(key, fresh);
		else hits.delete(key);
	}
}

export function cacheGet(key: string): string | null {
	sweep();
	const entry = store.get(key);
	if (!entry || Date.now() - entry.at > entry.ttl) {
		store.delete(key);
		return null;
	}
	return entry.value;
}

export function cacheSet(key: string, value: string, ttlSeconds: number): void {
	store.set(key, { value, at: Date.now(), ttl: ttlSeconds * 1000 });
}

/** True when this key has stayed under `limit` calls in the last minute. */
export function allow(key: string, limit: number): boolean {
	sweep();
	const now = Date.now();
	const times = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
	times.push(now);
	hits.set(key, times);
	return times.length <= limit;
}

/** For tests and the runbook's "is the cache warm" check. */
export function stats(): { entries: number; keys: number } {
	return { entries: store.size, keys: hits.size };
}
```

The limiter fails open, as the Workers binding did: a limiter that cannot decide
must not lock a reader out of search.

- [ ] **Step 2: the tags, adapted from the reference project**

```ts
/**
 * The cache groups a public page belongs to.
 *
 * Cloudflare's zone cache stores a page under the groups in its `Cache-Tag`
 * header. `plugins/cloudflare-purge` drops a group when content changes, so
 * the two must agree on the names — the same names EmDash invalidates in its
 * own query cache after a write: the collection and the entry id.
 *
 * Purging "posts" removes the home page, every archive, the feeds and the
 * post: nearly the whole site. That is deliberate — a re-render on the box
 * costs no quota, and one request to Cloudflare per publish (free plan: 5 a
 * minute) is the constraint worth respecting.
 *
 * Tags are per path, not per query: Astro's route cache is not used here, so
 * the middleware derives the groups from the path it is serving.
 */
export const CHROME_TAGS = [
	"emdash:settings",
	"emdash:taxonomy:category",
	"emdash:taxonomy:tag",
	"emdash:widget-area:header-banner",
	"emdash:widget-area:article-inline",
	"emdash:widget-area:sidebar",
	"emdash:widget-area:footer-about",
];

/** Every public page. The emergency switch; EmDash never purges it itself. */
export const ALL_TAG = "all";

const POST_PATH = /^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/;
const PAGED = /^(\/posts|\/category\/[^/]+|\/tag\/[^/]+|\/author\/[^/]+)(\/page\/\d+)?\/?$/;

/** Admin, its API, forms and the login page: never cached. */
const PRIVATE_PATH = /^\/(_emdash|admin|login|submit-a-claim|search)(\/|$)/;

export function collectionsForPath(pathname: string): string[] {
	if (PRIVATE_PATH.test(pathname)) return [];
	const path =
		pathname.endsWith("/") || /\.[a-z0-9]{2,5}$/i.test(pathname) ? pathname : `${pathname}/`;

	if (path === "/") return ["posts", "pages"];
	if (path === "/feed/" || path === "/rss.xml") return ["posts"];
	if (/^\/category\/[^/]+\/feed\/?$/.test(path)) return ["posts"];
	if (/^\/sitemap[^/]*\.xml$/.test(path)) return ["posts", "pages"];
	if (path === "/robots.txt") return ["posts", "pages"];
	if (POST_PATH.test(path)) return ["posts"];
	if (PAGED.test(path)) return ["posts"];
	// A page of the `pages` collection also lists posts in its sidebar.
	if (/^\/[^/]+\/?$/.test(path)) return ["pages", "posts"];
	return [];
}

export function tagsForPath(pathname: string): string[] {
	const collections = collectionsForPath(pathname);
	if (collections.length === 0) return [];
	return [...collections, ...CHROME_TAGS, ALL_TAG];
}
```

`/search` is private here on purpose: it is query-dependent and rate limited, so it must not be cached at the edge (the old `routeRules` never cached it either).

- [ ] **Step 3: unit test the tag map (new file `src/lib/cache-tags.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { collectionsForPath, tagsForPath } from "./cache-tags";

describe("cache tags", () => {
	it("covers the WordPress URL shapes", () => {
		expect(collectionsForPath("/")).toEqual(["posts", "pages"]);
		expect(collectionsForPath("/2025/04/18/flood-forecast-lagos/")).toEqual(["posts"]);
		expect(collectionsForPath("/category/fact-check/page/2")).toEqual(["posts"]);
		expect(collectionsForPath("/author/lanre-adebayo/")).toEqual(["posts"]);
		expect(collectionsForPath("/about-us/")).toEqual(["pages", "posts"]);
		expect(collectionsForPath("/feed/")).toEqual(["posts"]);
		expect(collectionsForPath("/sitemap.xml")).toEqual(["posts", "pages"]);
	});
	it("never caches the admin, the API, forms or search", () => {
		for (const path of ["/_emdash/admin", "/admin/", "/search/", "/submit-a-claim/", "/login"]) {
			expect(tagsForPath(path)).toEqual([]);
		}
	});
	it("always carries the emergency tag", () => {
		expect(tagsForPath("/")).toContain("all");
		expect(tagsForPath("/posts/")).toContain("posts");
	});
});
```

- [ ] **Step 4: run it**

```bash
pnpm vitest run src/lib/cache-tags.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "Cache tags per path and a TTL map to replace the Workers cache bindings"
```

### Task 6: Delete `src/worker.ts`, move weather to a route

**Files:** delete `src/worker.ts`, `worker-configuration.d.ts` (if present); create `src/pages/api/weather.ts`; modify `src/utils/weather.ts`

- [ ] **Step 1: the route**

```ts
/**
 * GET /api/weather?city=&country=&lat=&lon=
 *
 * The top-bar reading (src/components/WeatherCard.astro). Replaces the
 * WordPress EDGD Weather plugin. Served from one in-process cache per ~11 km
 * grid cell for half an hour, so Open-Meteo sees a handful of calls a day
 * whatever the traffic.
 *
 * On the VPS there is no `request.cf`: the visitor's coordinates come from the
 * browser's geolocation when it has granted it, and the site-settings place is
 * the fallback the page passes.
 */
import type { APIRoute } from "astro";
import { cacheGet, cacheSet } from "../../lib/kv-lite";
import { forecastUrl, gridOf, placeOf, readingOf } from "../../utils/weather";

const TTL_SECONDS = 30 * 60;

export const GET: APIRoute = async ({ request, url }) => {
	const fallback = new URLSearchParams(url.searchParams);
	const place = placeOf(undefined, fallback);
	if (!place) return Response.json({ error: "no location" }, { status: 404, headers: { "cache-control": "private, max-age=300" } });

	const key = `weather:${gridOf(place.latitude, place.longitude)}`;
	const cached = cacheGet(key);
	if (cached) return Response.json(readingOf(place, JSON.parse(cached)) ?? { error: "upstream" }, { headers: { "cache-control": `private, max-age=${TTL_SECONDS}` } });

	let body: unknown;
	try {
		const upstream = await fetch(forecastUrl(place.latitude, place.longitude), { signal: AbortSignal.timeout(6000) });
		if (!upstream.ok) return Response.json({ error: "upstream" }, { status: 502, headers: { "cache-control": "private, max-age=60" } });
		body = await upstream.json();
	} catch {
		return Response.json({ error: "upstream" }, { status: 502, headers: { "cache-control": "private, max-age=60" } });
	}

	const reading = readingOf(place, body);
	if (!reading) return Response.json({ error: "upstream" }, { status: 502, headers: { "cache-control": "private, max-age=60" } });
	cacheSet(key, JSON.stringify(body), TTL_SECONDS);
	return Response.json(reading, { headers: { "cache-control": `private, max-age=${TTL_SECONDS}` } });
};
```

- [ ] **Step 2: `placeOf` without the Cloudflare object**

In `src/utils/weather.ts` change the signature so the first argument is optional and always `undefined` from now on, and keep the query-string path:

```ts
export function placeOf(_cf: CfLocation | undefined, fallback: URLSearchParams): Place | null {
	const fallbackLat = coordinate(fallback.get("lat"));
	const fallbackLon = coordinate(fallback.get("lon"));
	if (fallbackLat === null || fallbackLon === null) return null;
	if (Math.abs(fallbackLat) > 90 || Math.abs(fallbackLon) > 180) return null;
	return {
		city: (fallback.get("city") ?? "").slice(0, 60) || "Your area",
		country: (fallback.get("country") ?? "").slice(0, 3),
		latitude: fallbackLat,
		longitude: fallbackLon,
	};
}
```

Delete the `CfLocation` interface, the `latitude`/`longitude` branch and the comment about `request.cf`; rewrite the module header ("On Cloudflare the city and coordinates already arrive with the request") to say the page passes the site-settings place and the browser may override it with its own geolocation.

- [ ] **Step 3: let the browser upgrade the place**

`src/components/WeatherCard.astro` fetches `/api/weather` with the settings city/lat/lon as query params. Add, before the fetch, an optional geolocation upgrade, and update the module comment (it claims the Worker reads the visitor's city from Cloudflare):

```js
	const params = new URLSearchParams({ city, country, lat, lon });
	// No server-side geolocation on this host: ask the browser, once, and only
	// if the visitor already allowed it (so nothing prompts).
	if (navigator.permissions) {
		try {
			if ((await navigator.permissions.query({ name: "geolocation" })).state === "granted") {
				const point = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { timeout: 1500, maximumAge: 600_000 }));
				if (point) { params.set("lat", point.coords.latitude.toFixed(3)); params.set("lon", point.coords.longitude.toFixed(3)); params.set("city", ""); }
			}
		} catch { /* fall back to the settings city */ }
	}
```

- [ ] **Step 4: delete the Worker entry point and its types**

```bash
git rm src/worker.ts
ls worker-configuration.d.ts 2>/dev/null && git rm worker-configuration.d.ts
grep -rn "cloudflare:workers" src plugins scripts || echo "only the files of later tasks remain"
```

Expected: the grep lists only `src/middleware.ts`, `src/env.d.ts`, `src/utils/{email,site,claims,turnstile}.ts`, `src/pages/share/...`, `plugins/resend-email/src/env.mjs` — each handled by Tasks 3, 7, 8, 10, 11.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Serve the site from Node: drop the Worker entry point, weather becomes a route"
```

### Task 7: Middleware — cache headers, limiter, no `cloudflare:workers`

**Files:** modify `src/middleware.ts`

- [ ] **Step 1: swap the imports**

Replace `import { env } from "cloudflare:workers";` with:

```ts
import { allow } from "./lib/kv-lite";
import { tagsForPath } from "./lib/cache-tags";
```

Replace `searchAllowed` with the local limiter (same 20/minute as the old `ratelimits` entry, same fail-open rule):

```ts
/** Searches per visitor per minute (was a Workers rate-limit binding). */
const SEARCH_LIMIT = 20;
function searchAllowed(request: Request): boolean {
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	return allow(`search:${ip}`, SEARCH_LIMIT);
}
```

and at the call site drop the `await`.

- [ ] **Step 2: add the header policy at the end of the handler**

After the sitemap rewrite block, before `return response`:

```ts
	// --- Edge cache policy (this deployment has no Astro cache provider) -----
	// Cloudflare caches only what a zone Cache Rule marks eligible, and honours
	// these headers for its own TTL. `stale-while-revalidate` is ignored when
	// s-maxage is present, so it is not used.
	if (response.status === 200 && isGet && !response.headers.has("cache-control")) {
		const tags = tagsForPath(pathname);
		const session = context.request.headers.get("cookie")?.includes("astro-session=");
		if (tags.length === 0 || session) {
			response.headers.set("cache-control", "private, no-store");
		} else {
			response.headers.set("cache-control", "public, max-age=300, s-maxage=2592000");
			response.headers.set("cache-tag", tags.join(","));
		}
	}
	if (response.status === 404 && isGet) {
		response.headers.set("cache-control", "public, max-age=60, s-maxage=60");
	}
	if (pathname.startsWith("/_emdash/api/media/file/") && response.status === 200) {
		// A media key is content-addressed or replaced by an upload; a year is
		// the Cloudflare maximum and costs nothing to state.
		response.headers.set("cache-control", "public, max-age=31536000, immutable");
	}
```

`Response` objects from Astro may be immutable in the Node adapter — construct the copy instead if a header set throws:

```ts
	const withHeaders = (res: Response, patch: Record<string, string>): Response => {
		const headers = new Headers(res.headers);
		for (const [name, value] of Object.entries(patch)) headers.set(name, value);
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	};
```

Use `response = withHeaders(response, {...})` in the block above and declare `let response = await next()`.

- [ ] **Step 3: www redirect moves here**

`src/worker.ts` did the `www → apex` 301 before Astro, because the Worker cache keyed on path only. Keep the same protection at the top of `onRequest`, using the request host:

```ts
	// www → apex, before anything is served or cached. The edge keys on the
	// path, so a redirect made after routing could be stored under the apex.
	const host = context.request.headers.get("host")?.replace(/:\d+$/, "");
	if (host && host !== "checkclimate.africa" && host !== "localhost" && !host.startsWith("vps.checkclimate.africa")) {
		if (host === "www.checkclimate.africa") {
			const target = new URL(context.request.url);
			target.hostname = "checkclimate.africa";
			target.protocol = "https:";
			return moved(target.toString(), context.url);
		}
	}
```

Expected after cutover: `curl -sI https://www.checkclimate.africa/ | head -1` → `HTTP/2 301`. (A zone Redirect Rule can do this instead; pick one, not both.)

- [ ] **Step 4: verify locally**

```bash
pnpm dev &
sleep 8
curl -s -o /dev/null -D - http://localhost:4321/ | grep -iE "cache-control|cache-tag"
curl -s -o /dev/null -D - http://localhost:4321/admin/ | grep -i cache-control
curl -s -o /dev/null -D - "http://localhost:4321/search/?q=flood" | grep -i cache-control
pkill -f "astro dev" || true
```

Expected: `/` → `public, max-age=300, s-maxage=2592000` plus a `cache-tag` line; `/admin/` and `/search/` → `private, no-store`.

- [ ] **Step 5: Commit**

```bash
git add src/middleware.ts src/lib/cache-tags.ts
git commit -m "Set cache-control and Cache-Tag in middleware; limiter and host redirect without Workers"
```

### Task 8: `src/env.d.ts` and the config-reading utils

**Files:** rewrite `src/env.d.ts`; modify `src/utils/{email,site,turnstile,claims}.ts`, `plugins/resend-email/src/env.mjs`, `vitest.config.ts`

- [ ] **Step 1: replace the bindings file with a process-env declaration**

```ts
/**
 * Ambient types for the site code.
 *
 * There are no platform bindings on this host: everything the app reads from
 * the environment is declared in src/runtime.ts, and Astro's own types cover
 * the rest.
 */
/// <reference types="astro/client" />

declare module "*.png" {
	const src: string;
	export default src;
}
```

```bash
git rm src/env.d.ts && git add src/env.d.ts
```

If `astro check` then reports a missing global for `crypto`/`Buffer`, add `/// <reference types="node" />` at the top of the file rather than reintroducing binding types.

- [ ] **Step 2: `src/utils/email.ts`**

Replace the `env` import with `import { runtime } from "../runtime";` and the three reads: `emailConfigured()` → `Boolean(runtime.resendApiKey)`, `defaultFrom()` → `runtime.emailFrom || FALLBACK_FROM`, and inside `sendEmail` `const apiKey = runtime.resendApiKey`. Update the header comment: the sentence about a 10 ms CPU budget no longer applies — say a fetch is I/O and sending is best-effort.

- [ ] **Step 3: `src/utils/turnstile.ts`**

`turnstileSiteKey()` → `runtime.turnstileSiteKey`; `turnstileSecretKey()` → `runtime.turnstileSecretKey`. Drop the `env` import.

- [ ] **Step 4: `src/utils/site.ts`**

Drop the `env` import, add `import { runtime } from "../runtime";`, replace the pinned-inbox line with:

```ts
		const pinned = runtime.claimsInbox;
```

and change the `SETTINGS_TTL_MS` comment: "per isolate" → "per process", and drop "the pages that read them are edge-cached for five minutes" (now 30 days, purged on publish).

- [ ] **Step 5: `plugins/resend-email/src/env.mjs`**

```js
/**
 * The only place this plugin touches the environment.
 *
 * On the box the process environment comes from /etc/checkclimate.env (systemd
 * reads it); in `astro dev` from `.env`. The vitest suite aliases this module to
 * a stub (see vitest.config.ts), which keeps the transport a plain function of
 * its arguments.
 */
const env = globalThis.process?.env ?? {};

/** Resend API key, or "" when mail is not configured. */
export function resendApiKey() {
	return typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
}

/** Default From: header, e.g. `Check Climate Africa <newsroom@checkclimate.africa>`. */
export function resendFrom() {
	return typeof env.EMAIL_FROM === "string" ? env.EMAIL_FROM.trim() : "";
}
```

- [ ] **Step 6: the vitest alias**

In `vitest.config.ts` the `cloudflare:workers` stub alias is now dead. Replace its alias target with `plugins/resend-email/src/env.mjs` mapped to the same stub file, so the transport tests keep passing unchanged:

```ts
		alias: {
			"@checkclimate/plugin-resend-email/env": "./plugins/resend-email/src/env.test-stub.mjs",
		},
```

If the existing alias key was literally `"cloudflare:workers"`, keep the key name but point the resend plugin's `./env.mjs` import at the stub via the same mechanism it already uses; the requirement is only that `pnpm test` passes with no `cloudflare:workers` import anywhere.

- [ ] **Step 7: tests and typecheck**

```bash
pnpm test 2>&1 | tail -8
pnpm typecheck 2>&1 | tail -20
```

Expected: the resend transport suite passes; `typecheck` still errors on the share route and claims (Tasks 10–11). List what remains and continue.

- [ ] **Step 8: Commit**

```bash
git add src/utils plugins/resend-email vitest.config.ts src/env.d.ts
git commit -m "Read mail, Turnstile, claims and settings config from the process environment"
```

---

## Phase D — Features that used Workers-only services

### Task 9: `plugins/cloudflare-purge` (adapt the reference)

**Files:** create `plugins/cloudflare-purge/{package.json,index.mjs,env.mjs}`; register it in `astro.config.mjs` `localPluginSources`

- [ ] **Step 1: the plugin package**

Copy the three files from `/Users/olalekan/Projects/securityfocus/plugins/cloudflare-purge/` (they are Apache-tolerated in-repo patterns; the site is your own), renaming the namespace:

- `package.json`: `"name": "@checkclimate/plugin-cloudflare-purge"`.
- `env.mjs`: identical (reads `globalThis.process?.env`).
- `index.mjs`: keep every hook and the retry loop verbatim, but change the `entrypoint` in `cloudflarePurge()` to `"@checkclimate/plugin-cloudflare-purge"`, and in the config (Task 4) import it as `import { cloudflarePurge } from "@checkclimate/plugin-cloudflare-purge";`. Update the header comment's domain/bucket references to `checkclimate`.
- The purge tags are whatever came through `content:afterSave/Publish/Unpublish/Delete/Restore` — that is `event.collection` (`posts`/`pages`) and the entry id, exactly the names `src/lib/cache-tags.ts` emits. No other change.

- [ ] **Step 2: register the source** in `astro.config.mjs` `localPluginSources`:

```js
	{
		id: "checkclimate-cloudflare-purge",
		displayName: "Cloudflare purge",
		description: "Purges the zone cache by tag on publish, unpublish, delete, restore and live-edit.",
		version: "1.0.0",
		format: "native",
		entrypoint: "@checkclimate/plugin-cloudflare-purge",
		capabilities: ["content:read"],
		source: "./plugins/cloudflare-purge/index.mjs",
	},
```

Add the alias automatically from `localPluginSources` (it already maps every `entrypoint` to its `source`, so no manual alias editing is needed).

- [ ] **Step 3: unit-test the purge request**

Create `plugins/cloudflare-purge/purge.test.ts` with a mocked `fetch` that returns 429 then 200, asserting the request is retried and the plugin logs success on the second attempt. (Pattern: `plugins/resend-email/src/transport.test.ts`.)

```bash
pnpm vitest run plugins/cloudflare-purge/purge.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/cloudflare-purge astro.config.mjs
git commit -m "Purge the edge by Cache-Tag on content changes"
```

### Task 10: Media writes — `src/utils/media-store.ts` + claims

**Files:** create `src/utils/media-store.ts`; modify `src/utils/claims.ts`, `src/pages/share/[format]/[slug].png.ts`

Now that there is no `env.MEDIA`, the two places that wrote objects directly to R2 (`claims.ts`, the share route) go through a single S3 helper. It resolves the same `S3_*` values the `s3()` storage adapter uses, so it talks to the same bucket and keys.

- [ ] **Step 1: the helper**

```ts
/**
 * Direct object access to the media bucket for the two cases the EmDash media
 * library does not cover well: the claim-form evidence (uploaded before the
 * library row exists) and the opaque share-card cache. Everything else goes
 * through EmDash's storage adapter.
 *
 * Configured by the same S3_* variables as emdash's s3() adapter, so it always
 * points at checkclimate-media.
 */
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client({
	region: process.env.S3_REGION || "auto",
	endpoint: process.env.S3_ENDPOINT,
	credentials: {
		accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
	},
});
const BUCKET = process.env.S3_BUCKET ?? "";

export async function getObject(key: string): Promise<{ body: Buffer; contentType?: string } | null> {
	if (!BUCKET || !process.env.S3_ACCESS_KEY_ID) return null;
	try {
		const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
		if (!res.Body) return null;
		const bytes = await res.Body.transformToByteArray();
		return { body: Buffer.from(bytes), contentType: res.ContentType };
	} catch (error) {
		const code = (error as { name?: string }).name;
		if (code === "NoSuchKey") return null;
		throw error;
	}
}

export async function putObject(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<boolean> {
	if (!BUCKET || !process.env.S3_ACCESS_KEY_ID) return false;
	await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: contentType }));
	return true;
}

export async function deleteObject(key: string): Promise<void> {
	if (!BUCKET || !process.env.S3_ACCESS_KEY_ID) return;
	try {
		await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
	} catch {
		// Best-effort cleanup.
	}
}
```

The three call sites:

- **`claims.ts` `storeAttachment`:** `const put = await env.MEDIA.put(storageKey, bytes, {...})` becomes `await putObject(storageKey, bytes, file.type)`; the `url` and library-registration stay identical. `discardAttachment`'s `env.MEDIA.delete(storageKey)` becomes `await deleteObject(storageKey)`.
- **`discardAttachment`:** unchanged otherwise.
- **`share/...png.ts`:** `mediaStore.get`/`put` read and write the cache key the same way `env.MEDIA` did.

- [ ] **Step 2: fail safely when S3 is unconfigured**

In dev/CI the `s3()` adapter is not used (storage falls back to local), and `media-store` returns `null`/`false` when credentials are absent. `claims.ts` already treats a failed upload as a user-facing "could not save" — keep that; the share route will throw and return 503, which is fine for an unconfigured dev box.

- [ ] **Step 3: verify the S3 helper round-trips in dev**

```bash
node --input-type=module -e "
import('./src/utils/media-store.ts').then(async (m) => {
	if (m.getObject && !process.env.S3_BUCKET) { console.log('no S3 configured — skips, as designed'); process.exit(0); }
});"
```

Expected: the dev guard prints the skip line. Full round-trip happens on the box (Task 17).

- [ ] **Step 4: Commit**

```bash
git add src/utils/media-store.ts src/utils/claims.ts 'src/pages/share/[format]/[slug].png.ts'
git commit -m "Route claim evidence and share-card caches through the S3 media helper"
```

### Task 11: Share cards with sharp + opentype.js

**Files:** create `share/fonts/*.ttf`, `share/fonts/OFL.txt`, `src/utils/share-render.ts`; rewrite `src/pages/share/[format]/[slug].png.ts`

The old renderer used the Workers **Images binding** (`env.IMAGES.text`, opacity, compositing). The layout abstraction (`src/utils/share-card.ts`, pure: DrawOps with positions) is unchanged; only the painter changes. Text is drawn as glyph paths (opentype.js) inside one SVG, so rendering never depends on the box's installed fonts; sharp composites the raster layers over the base.

- [ ] **Step 1: get the fonts**

Red Hat Display is SIL-OFL; static TTFs are served by the Google Fonts CSS API (variable TTF otherwise). Download the 500/700/900 TTFs and the OFL license into `share/fonts/`:

```bash
mkdir -p share/fonts
for w in 500 700 900; do
  url=$(curl -s "https://fonts.googleapis.com/css?family=Red+Hat+Display:$w" | grep -oE 'https://[^)]*\.ttf' | head -1)
  curl -s "$url" -o "share/fonts/red-hat-display-$w.ttf"
done
curl -s "https://raw.githubusercontent.com/google/fonts/main/ofl/redhatdisplay/OFL.txt" -o share/fonts/OFL.txt
file share/fonts/red-hat-display-500.ttf share/fonts/red-hat-display-700.ttf share/fonts/red-hat-display-900.ttf
```

Expected: `file` reports `TrueType Font data` for all three. If the CSS API returns woff2 (empty grep), fall back to fonttools: `pip install fonttools brotli` then instance the variable font at 500/700/900 with `fonttools varLib.instancer`. Verify the middle variant is really weight 500 with `fc-scan` or by checking `OS/2.usWeightClass`.

- [ ] **Step 2: `src/utils/share-render.ts`**

```ts
/**
 * Paints a fact-check share card to PNG.
 *
 * The old painter was the Workers Images binding (text overlays, opacity,
 * compositing, capped at 10 transforms a chain). This one is platform-neutral:
 * the layout (src/utils/share-card.ts) is a pure list of DrawOps, and we turn
 * it into (a) a stack of raster layers sharps composites over the base and (b)
 * one SVG holding every text line as a glyph path, so no system font is needed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import type { DrawOp, ShareFormat, ShareLayout, FontWeight } from "./share-card";

/** How much of the photo shows through the shade (moved from the route). */
export const PHOTO_OPACITY = 0.35;

const here = dirname(fileURLToPath(import.meta.url));

// Loaded lazily and cached: three ~40 KB TTFs.
const fontCache = new Map<FontWeight, opentype.Font>();
function loadFont(weight: FontWeight): opentype.Font {
	let font = fontCache.get(weight);
	if (!font) {
		const data = readFileSync(join(here, "../../share/fonts/red-hat-display-" + weight + ".ttf")).buffer as ArrayBuffer;
		font = opentype.parse(data);
		fontCache.set(weight, font);
	}
	return font;
}

/** Baseline for a top-anchored line. opentype y is the baseline; ascent maps a
 * DrawOp's `top` to where the first baseline sits. */
function baselineY(top: number, size: number, font: opentype.Font): number {
	return top + size * (font.ascender / font.unitsPerEm + 0.06);
}

/** One SVG at the card's own size; every text line becomes a filled path. */
function textLayerSvg(layout: ShareLayout, ops: DrawOp[]): string {
	const lines: string[] = [];
	for (const op of ops) {
		if (op.kind !== "text") continue;
		const font = loadFont(op.weight);
		const path = font.getPath(op.text, op.left, baselineY(op.top, op.size, font), op.size);
		const d = path.toPathData(2);
		if (!d) continue; // whitespace-only line
		lines.push(`<path d="${d}" fill="${op.color}"/>`);
	}
	if (lines.length === 0) return "";
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
		...lines,
		"</svg>",
	].join("");
}

/** Raster card from a photo buffer (Bytes) plus the asset/logo stamps. */
export async function renderCard(
	format: ShareFormat,
	layout: ShareLayout,
	photo: Buffer | null,
	shade: Buffer,
	assets: Array<{ data: Buffer; left: number; top: number }>,
	baseOrigin: string,
): Promise<Buffer> {
	const sharp = (await import("sharp")).default;
	const { width, height } = layout;
	const composites: Array<import("sharp").OverlayOptions> = [];

	if (photo) {
		// Cover-crop to the card, then flatten to a constant alpha so the base
		// reads through exactly as the Workers Images overlay did.
		const resized = await sharp(photo).resize({ width, height, fit: "cover" }).toBuffer();
		const faded = await sharp(resized).removeAlpha().ensureAlpha(PHOTO_OPACITY).png().toBuffer();
		composites.push({ input: faded, left: 0, top: 0 });
	}
	composites.push({ input: shade, left: 0, top: 0 });
	for (const a of assets) composites.push({ input: a.data, left: a.left, top: a.top });

	const textSvg = textLayerSvg(layout, layout.ops);
	if (textSvg) {
		const textPng = await sharp(Buffer.from(textSvg)).png().toBuffer();
		composites.push({ input: textPng, left: 0, top: 0 });
	}

	// The base lives in public/share/base-<format>.png; fetch it here by path.
	const base = await (await fetch(baseOrigin + "/share/base-" + format + ".png")).arrayBuffer();
	let out = sharp(Buffer.from(base));
	if (composites.length) out = out.composite(composites);
	return out.png().toBuffer();
}
```

Rewrite the route (`src/pages/share/[format]/[slug].png.ts`) to:
- keep the slug/claim/verdict guards, the `key` hash, the R2 cache read/write (now `media-store`), the `?download` header and the `asset()`/`photo()` fetchers (photo via `media-store` for media-library keys, else fetch);
- replace the `flush`/`draw`/`env.IMAGES` loop with one call to `renderCard(format, shareLayout(format, input), photoBuf, shadeBuf, assetOps, origin)`: `assetOps` is `layout.ops.filter(op => op.kind === "asset")` with each `op.path` fetched from `public/share` as a buffer, and `renderCard` draws the text ops itself;
- keep the two-layer order from the old code: photo → shade → stamps → text.

- [ ] **Step 3: decode the draw ordering exactly**

Confirm from `src/utils/share-card.ts` that `layout.ops` lists images before text (the old chain flushed images first, then text). If an image op must sit above text, split `ops` into a pre-text stack and post-text stack and pass `assets` accordingly. The goal is **visual parity** with the current live `/share/wide/<slug>.png` — diff a card side by side at cutover and list in the runbook which pixels are allowed to move.

- [ ] **Step 4: build and smoke-test one card**

```bash
pnpm build:vps
node --env-file=.env ./dist/server/entry.mjs & sleep 4
curl -s -o /tmp/share-wide.png -D - "http://localhost:4331/share/wide/any-fact-check-slug?download" | head -3
file /tmp/share-wide.png
```

Expected: `image/png`, 1200×630, `content-disposition: attachment`.

- [ ] **Step 5: Commit**

```bash
git add share/fonts src/utils/share-render.ts 'src/pages/share/[format]/[slug].png.ts'
git commit -m "Render fact-check share cards on Node with sharp and glyph paths"
```

### Task 12: Search — SQLite gains full-text search

**Files:** modify `src/utils/search.ts`, `src/pages/search/index.astro`, `emDash` collection definitions

The old search was a Postgres ILIKE over the three text fields. On SQLite, EmDash's `search()` (FTS5) is available again — the PLAN/STATUS noted it was Postgres-only. The migration copies content with search **off** (`search_unsupported`, per the transfer docs), so Task 16 re-enables search after the copy; this task swaps the query so it uses FTS when present and falls back to LIKE (still plain SQLite) otherwise.

- [ ] **Step 1: rewrite `searchPosts`**

```ts
import { search } from "emdash";

export async function searchPosts(query: string, page = 1, perPage = 10): Promise<SearchPage> {
	const safePage = Number.isFinite(page) && page > 1 ? Math.floor(page) : 1;
	const terms = tokenize(query);
	if (terms.length === 0) return { posts: [], page: safePage, hasMore: false };
	try {
		const result = await search("posts", query, {
			filter: { published: true },
			sort: { field: "published_at", order: "desc" },
			limit: perPage,
			offset: (safePage - 1) * perPage,
		});
		return { posts: result.pages ?? result.items ?? [], page: safePage, hasMore: !!result.hasMore };
	} catch (error) {
		// FTS unavailable (still Postgres, or the index is rebuilding): LIKE.
		return fallbackLike(query, safePage, perPage);
	}
}
```

Match the actual EmDash `search()` signature (check `emdash` types with `pnpm types` / its `.d.mts`) and the `searchPosts` consumers (the search page and archive). Keep `tokenize`, `likePattern`, `termCondition` for `fallbackLike`, written against SQLite (`content` is TEXT, not JSON — drop the `::text` cast).

- [ ] **Step 2: typecheck and a manual end-to-end**

```bash
pnpm typecheck 2>&1 | tail -10
pnpm dev & sleep 8
curl -s "http://localhost:4321/search/?q=flood" | grep -oE "flood" | head -1
pkill -f "astro dev" || true
```

Expected: `pnpm typecheck` clean; the search page returns results containing "flood".

- [ ] **Step 3: Commit**

```bash
git add src/utils/search.ts src/pages/search
git commit -m "Search via EmDash full-text on SQLite, with a LIKE fallback"
```

---

## Phase E — The box, the data, the cutover

Server-side steps are the owner's (decision of 2026-11-24): the plan produces
`deploy/` files and `docs/vps-runbook.md`, and every owner command is written
**one per line** in the runbook so a paste cannot wrap.

### Task 13: `deploy/` files

**Files:** create `deploy/nginx-proxy.conf`, `deploy/checkclimate.service`, `deploy/sudoers-checkclimate`, `deploy/checkclimate.env.example`, `deploy/checkclimate.build.env.example`, `deploy/cloudflare-ips.txt`

- [ ] **Step 1: `cloudflare-ips.txt`** — copy verbatim:

```bash
cp /Users/olalekan/Projects/securityfocus/deploy/cloudflare-ips.txt deploy/cloudflare-ips.txt
```

- [ ] **Step 2: `nginx-proxy.conf`** — copy the reference file and apply exactly these
  deltas (the reference is correct about `listen <box-ip>`, the
  `geo $realip_remote_addr` allowlist and `set_real_ip_from`, all of which carry
  over unchanged):

| Reference | This site |
|---|---|
| `geo $realip_remote_addr $securityfocus_from_cloudflare` | `geo $realip_remote_addr $checkclimate_from_cloudflare` |
| `if ($securityfocus_from_cloudflare = 0)` | `if ($checkclimate_from_cloudflare = 0)` |
| `server_name securityfocus.ng vps.securityfocus.ng;` | `server_name checkclimate.africa vps.checkclimate.africa;` |
| `ssl_certificate /etc/ssl/securityfocus/origin.pem` (+ key) | `/etc/ssl/checkclimate/origin.pem` (+ `.key`) |
| `proxy_pass http://127.0.0.1:4321;` | `proxy_pass http://127.0.0.1:4331;` |
| header comment | name the two hosts, note that `www` never reaches the origin (middleware/Redirect Rule), and that `conf.d/` wins over Virtualmin's vhost |

Keep `client_max_body_size 64m;` (claim attachments are capped at 8 MB, but the
site transfer import in Task 16 uploads a package of a few hundred MB through
the same vhost: **raise it to `512m` for the staging host only** or run the
import on the laptop against a local build and copy the file in instead —
pick the second, it is what the RUNBOOK already does for the WordPress import).

- [ ] **Step 3: `checkclimate.service`** — copy the reference unit, changing
  every `securityfocus` to `checkclimate` and adding the one thing this site
  needs that Security Focus did not: the build-time path variables are already
  baked into the bundle, so the unit needs only `EnvironmentFile` plus:

```ini
# The site transfer import (Task 16) writes ~200 MB of media into R2 through
# this process; give the sweep and the import room to finish.
TimeoutStartSec=120
```

Final `ExecStart`:

```ini
ExecStart=/home/checkclimate/.local/share/fnm/aliases/default/bin/node ./dist/server/entry.mjs
```

`ReadWritePaths=/home/checkclimate/data /home/checkclimate/app/.astro`.

- [ ] **Step 4: `sudoers-checkclimate`** — the reference file with the user and
  service renamed, installed with:

```bash
sudo install -o root -g root -m 440 deploy/sudoers-checkclimate /etc/sudoers.d/checkclimate
sudo visudo -c
```

- [ ] **Step 5: `checkclimate.env.example`** (runtime, root 600). Same shape as
  the reference; the values that differ:

```bash
EMDASH_SITE_URL=https://checkclimate.africa
DATABASE_PATH=/home/checkclimate/data/emdash.db
SESSION_DIR=/home/checkclimate/data/sessions
HOST=127.0.0.1
PORT=4331
EMDASH_ENCRYPTION_KEY=
RESEND_API_KEY=
EMAIL_FROM=Check Climate Africa <newsroom@notify.checkclimate.africa>
CLAIMS_INBOX=
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_PURGE_ENABLED=1
S3_ENDPOINT=https://9c8aaa232a52d145430685011e9fff9c.r2.cloudflarestorage.com
S3_BUCKET=checkclimate-media
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_REGION=auto
```

`EMDASH_ENCRYPTION_KEY` must be **the same value the Worker uses today** (it is
in the repo's `.env`, which is why it was kept): the Resend key and Turnstile
secret are encrypted with it inside the database, and the site package carries
those ciphertexts. A new key makes every stored setting unreadable.

- [ ] **Step 6: `checkclimate.build.env.example`** (root 644, sourced by the
  deploy script before `astro build`) — `EMDASH_SITE_URL`, `DATABASE_PATH`,
  `SESSION_DIR`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION` only. No secrets.

- [ ] **Step 7: Commit**

```bash
git add deploy
git commit -m "Deploy files for the VPS: nginx vhost, systemd unit, sudoers, env templates"
```

### Task 14: Deploy and backup scripts

**Files:** create `scripts/deploy-vps.sh`, `scripts/backup-vps.sh`

- [ ] **Step 1: `deploy-vps.sh`** — copy the reference script
  (`/Users/olalekan/Projects/securityfocus/scripts/deploy-vps.sh`) and change:

| Reference | This site |
|---|---|
| `APP=/home/securityfocus/app`, `DATA=/home/securityfocus/data` | `/home/checkclimate/…` |
| `BRANCH=vps` | `BRANCH=main` (the server checkout must be on `main`; the `vps` branch merges there at cutover) |
| build env file `/etc/securityfocus.build.env` | `/etc/checkclimate.build.env` |
| service `securityfocus.service` | `checkclimate.service` |
| smoke test `curl -fsS http://127.0.0.1:4321/` | `:4331/` |
| refuse-dirty-tree and `git pull --ff-only` logic | unchanged |
| `pnpm install --frozen-lockfile` then `pnpm build` | `pnpm install --frozen-lockfile` then `pnpm build:vps` |

Keep its final step: print the first 20 journal lines when the smoke test fails,
and exit non-zero so the workflow shows red.

- [ ] **Step 2: `backup-vps.sh`** — copy the reference and rename paths; the
  three rules the reference encodes stay: `sqlite3 "$DB" ".backup '$TARGET'"`
  (never `cp`, WAL), `PRAGMA integrity_check` on the copy, keep 14 days, and
  `cd` into the backup directory before `find`. Off-site target is a **separate
  private R2 bucket** (`checkclimate-backups`), never `checkclimate-media`: the
  media route serves any key in that bucket. rclone remote with
  `provider = Cloudflare` and **`no_head = true`**.

- [ ] **Step 3: make them executable and shellcheck-clean**

```bash
chmod +x scripts/deploy-vps.sh scripts/backup-vps.sh
bash -n scripts/deploy-vps.sh && bash -n scripts/backup-vps.sh && echo "syntax ok"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-vps.sh scripts/backup-vps.sh
git commit -m "Deploy and nightly backup scripts for the box"
```

### Task 15: CI → the box

**Files:** modify `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`

- [ ] **Step 1: `ci.yml`** (dev + PRs) keeps install → typecheck → test → build,
  and drops `wrangler deploy --dry-run`. Add the SQLite path so the build has a
  target:

```yaml
      - run: pnpm typecheck
      - run: pnpm test
      - name: Build for the box
        env:
          DATABASE_PATH: /home/checkclimate/data/emdash.db
          SESSION_DIR: /home/checkclimate/data/sessions
          EMDASH_SITE_URL: https://checkclimate.africa
          EMDASH_STORAGE: local
        run: pnpm build:vps
      - name: Keep the standalone server out of the artifact
        run: rm -rf dist/client node_modules/.vite
```

- [ ] **Step 2: `deploy.yml`** — replace the `main` job's Cloudflare deploy with
  the reference project's tree-match + forced-command SSH deploy + purge
  sequence, using `securityfocus`→`checkclimate`, `VPS_HOST`/`VPS_SSH_KEY`/
  `VPS_KNOWN_HOSTS` secrets and `CLOUDFLARE_PURGE_TOKEN` for the zone purge
  step. Copy `.github/workflows/deploy.yml` from `/Users/olalekan/Projects/
  securityfocus/` and apply those renames; the `ZONE:` literal becomes the
  `checkclimate.africa` zone id (owner input).

- [ ] **Step 3: keep the Workers workflow as `deploy-workers.yml.disabled`**

Rename the current Cloudflare deploy workflow's file so the box deploy is the
only one that runs, but the exact commands stay recoverable for the rollback:

```bash
git mv .github/workflows/deploy.yml .github/workflows/deploy-workers.yml.disabled
```

Then write the new `deploy.yml` (Step 2) and `ci.yml` (Step 1).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows
git commit -m "Build and ship to the VPS from CI; park the Workers pipeline"
```

### Task 16: Copy the content — Postgres → SQLite

The only supported cross-engine path is EmDash's site transfer ("Export from
SQLite, PostgreSQL, or D1 and import into any of them"). Run **both ends on the
laptop**: exporting from the deployed Worker would push a multi-hundred-record
walk through the 10 ms CPU cap, and a retry loop is exactly what burned the
quota. Media does not move — it is the same R2 bucket — but the package carries
it, and re-importing the same keys into the same bucket is harmless.

**Files:** create `scripts/pg-to-sqlite.mjs`

- [ ] **Step 1: export from Neon (local dev against the prod branch)**

```bash
L=postgresql://postgres:localimport@localhost:5433/checkclimate
psql "$NEON_DATABASE_URL" -c 'select count(*) from ec_posts' # must be 172+ (newsroom has posted since)
```

Boot a dev server whose Hyperdrive local string is the **Neon prod** URL
(the RUNBOOK's import playbook), then drive the transfer API:

```bash
NEON_DATABASE_URL="$NEON_PROD_URL" CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_PROD_URL" \
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED="$NEON_PROD_URL" pnpm exec astro dev --port 4321
```

`scripts/pg-to-sqlite.mjs` step 1 does the calls, advancing until
`nextRequestInMs` is `null` and downloading the package:

```js
const base = "http://localhost:4321/_emdash/api/admin/transfer";
const headers = { Authorization: `Bearer ${process.env.EMDASH_TOKEN}` };
const start = async () => {
	const res = await fetch(`${base}/exports`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json", "idempotency-key": "move-to-vps-2026-11-24" },
		body: JSON.stringify({ comments: true }),
	});
	if (!res.ok) throw new Error(`export start ${res.status}: ${await res.text()}`);
	return (await res.json()).operation ?? (await res.json());
};
const advance = async (id) => {
	for (let i = 0; i < 5000; i++) {
		const res = await fetch(`${base}/exports/${id}/advance`, { method: "POST", headers });
		const body = await res.json();
		const op = body.operation ?? body;
		if (op.nextRequestInMs) await new Promise((r) => setTimeout(r, op.nextRequestInMs));
		else return op;
	}
	throw new Error("export did not finish");
};
const op = await advance((await start()).id);
if (op.state !== "complete") throw new Error(`export ${op.state}: ${op.errorCode}`);
const file = await fetch(`${base}/exports/${op.id}/download`, { headers });
const buffer = Buffer.from(await file.arrayBuffer());
const { writeFileSync } = await import("node:fs");
writeFileSync("data/checkclimate.emdash", buffer);
console.log("package bytes", buffer.length);
```

Expected: `data/checkclimate.emdash` (gitignored), a few hundred MB, progress
lines with record counts.

- [ ] **Step 2: import into a fresh local SQLite file**

```bash
rm -f data/migrate.db data/migrate.db-wal data/migrate.db-shm
DATABASE_PATH="$PWD/data/migrate.db" SESSION_DIR="$PWD/data/sessions-migrate" \
EMDASH_STORAGE=local EMDASH_SITE_URL=http://localhost:4322 pnpm exec astro dev --port 4322
```

Then the same script, second mode (`--import`): `POST /transfer/imports` with
the package as multipart form data, `advance` until
`nextRequestInMs` is `null`, and read the **receipt** — it is the gate:

```bash
node scripts/pg-to-sqlite.mjs --import data/checkclimate.emdash --url http://localhost:4322
```

Expected: a receipt with `state: "verified"` and per-kind totals. Record the
totals (posts, pages, categories, tags, media, comments) — Task 17 compares
them against the box.

- [ ] **Step 3: re-enable search, since Postgres had none**

The transfer guide: collections with search enabled are imported with search
**off** and reported `search_unsupported`. In the admin of the local SQLite
build (4322), turn search back on for `posts` and `pages`, then warm the index
with one request:

```bash
curl -s "http://localhost:4322/_emdash/api/search?q=flood" | head -c 200
```

Expected: JSON with at least one hit. (`Task 12`'s LIKE fallback covers the
window before this runs.)

- [ ] **Step 4: fix the migration scripts to speak SQLite**

`scripts/{post-import,verify-migration,unwrap-wayback,relink-media,taxonomy-reorg,index-post-filters}.ts`
all use `pg` directly (`--database=dev|prod`). Task 2 removed the driver, so:

```bash
grep -rln "from \"pg\"\|require(\"pg\")" scripts
```

For each hit, add a `--database=sqlite` mode over `node:sqlite`
(`new DatabaseSync(path)`) for the read-only checks (`verify-migration`'s
counts, `post-import`'s report) and mark the Postgres paths
`@deprecated (Workers era)`: the import from WordPress is finished and those
scripts only ever ran against Neon. Do not port `unwrap-wayback` or
`relink-media` — they were one-time passes and their artifacts
(`migration/*.json`) already reflect the result.

`verify-migration.ts --database=sqlite --db=data/migrate.db` must print the
counts and exit 0 against the imported file.

- [ ] **Step 5: Commit**

```bash
git add scripts
git commit -m "Copy the site from Neon Postgres to SQLite through EmDash site transfer"
```

### Task 17: Put it on the box (owner runs; agent writes the runbook)

**Files:** create `docs/vps-runbook.md` (owner's manual: one command per line, the
same shape as `securityfocus/docs/vps-runbook.md` — §0 step table, §1 what is
where, §2 check the box, §3 Node/pnpm, §4 the app, §5 tokens and env files, §6
the service, §7 the database, §8 nginx and TLS, §9 backups, §10 restore, §11
staging, §12 cutover, §13 deploy a change, §14 logs, §15 the cache, §16 rotate a
secret, §17 troubleshooting), plus the `deploy/` files this task installs.

- [ ] **Step 1:** owner creates the Virtualmin user/site `checkclimate`, the
  directories `/home/checkclimate/{app,data,data/sessions,backups}` and installs
  `deploy/*` (one command per line in the runbook).
- [ ] **Step 2:** owner installs Node 24 for that user with fnm, runs
  `fnm default 24`, and verifies `~/.local/share/fnm/aliases/default/bin/node -v`.
- [ ] **Step 3:** clone the `vps` branch into `/home/checkclimate/app`; install
  `/etc/checkclimate.env` (600) and `/etc/checkclimate.build.env` (644) with the
  real values, including **the same `EMDASH_ENCRYPTION_KEY` as the Worker**.
- [ ] **Step 4:** `scp data/migrate.db` (plus `-wal`/`-shm` removed first) into
  `/home/checkclimate/data/emdash.db`, chown to the site user, then
  `systemctl enable --now checkclimate`.
- [ ] **Step 5:** origin certificate for `checkclimate.africa` +
  `*.checkclimate.africa` into `/etc/ssl/checkclimate/`; install the nginx
  `conf.d/` file; `nginx -t` then `systemctl reload nginx`.
- [ ] **Step 6:** staging DNS `A vps → 169.58.2.239` (**proxied**), the zone
  Cache Rule (Task 18), rebuild with `EMDASH_SITE_URL=https://vps.checkclimate.africa`,
  and run the checks in Task 19.
- [ ] **Step 7:** nightly backup cron + rclone remote to `checkclimate-backups`.

### Task 18: The Cloudflare Cache Rule (nothing works without it)

- [ ] Dashboard → the `checkclimate.africa` zone → Rules → Cache Rules → Create:
  - If: `(http.host in {"checkclimate.africa" "vps.checkclimate.africa"} and not starts_with(http.request.uri.path, "/_emdash") and not http.cookie contains "astro-session=")`
  - Then: **Eligible for cache**; Edge TTL = **Eligible for cache** ("Use cache-control header if present").
- [ ] Confirm SSL/TLS mode is **Full (strict)** for the origin certificate.
- [ ] Record the zone id in `deploy/checkclimate.env.example`'s comment and in
  the runbook's inputs table (never commit the token).

### Task 19: Staging checks before cutover

All against `https://vps.checkclimate.africa`:

- [ ] `curl -sI` twice on `/`: second response is `cf-cache-status: HIT`.
- [ ] `/`, one article, one fact check, `/category/fact-check/`, `/tag/<x>/`,
  `/author/<x>/`, `/posts/page/2/`, `/about-us/`, `/contact-us/`,
  `/privacy-policy/`, `/accessibility-statement/`, `/search/?q=flood`,
  `/submit-a-claim/`, `/feed/`, `/sitemap.xml`, `/robots.txt`, `/admin/` → 200.
- [ ] `/wp-content/uploads/<an old path>` → 301 to R2 media; `/wp-admin/` → 301
  `/admin/`; `/megamenu/x` → 410.
- [ ] An image from a post loads (proves the R2 token), and `/share/wide/<fact
  check slug>.png` renders — compare it with the live Worker's card, pixel-close.
- [ ] Publish a draft post: `journalctl -u checkclimate | grep cloudflare-purge`
  shows the purge, and home goes MISS → HIT.
- [ ] A scheduled post (+5 min) goes live on its own, with a purge line.
- [ ] Magic-link sign-in arrives through Resend (passkeys will not work on the
  staging host — expected, they are bound to the domain).
- [ ] A claim submission lands in the `claims` collection with its attachment
  readable.
- [ ] `sqlite3 /home/checkclimate/data/emdash.db 'pragma integrity_check'` → `ok`,
    and the per-kind counts equal the Task 16 receipt.
- [ ] `scripts/backup-vps.sh` runs and the object appears in
    `checkclimate-backups`.

### Task 20: Cutover, then retitle the docs

- [ ] Freeze content (no posts while this runs) and take a fresh copy: repeat
  Task 16 steps 1–2, stop the service, swap
  `/home/checkclimate/data/emdash.db`, remove `-wal`/`-shm`, chown, restart.
- [ ] Rebuild with `EMDASH_SITE_URL=https://checkclimate.africa` in **both** env
  files; add the apex to `server_name` (already there in the committed file).
- [ ] Cloudflare: delete the custom hostname from the `checkclimate` Worker, add
  `A @ → 169.58.2.239` proxied, keep `AAAA` out unless the box has v6, add the
  apex to the Cache Rule (Task 18), `www` → root (Redirect Rule or the
  middleware block — one only), then **Purge Everything**.
- [ ] Smoke test: apex 200 with `cf-cache-status: MISS` then `HIT`; every route
  from Task 19; **passkey** login at `/_emdash/admin` now works (same domain).
- [ ] **Delete the Worker's cron triggers** — otherwise 96 runs a day keep
  reading Neon and sending quota mail.
- [ ] Keep the Worker, Hyperdrive configs, KV namespaces and the Neon branch for
  14 days as the rollback (re-attaching the custom hostname is the undo), then
  the owner decides. **Never delete the R2 media bucket.**
- [ ] `git merge vps` into `main` (owner), tag `vps-cutover-2026-11-24`.
- [ ] Rewrite `docs/RUNBOOK.md` for the box (secrets file instead of `wrangler
  secret put`, `journalctl -u checkclimate` instead of `wrangler tail`, the
  migration-lock section becomes a SQLite/`_emdash_migrations_lock` psql→sqlite3
  line, backups point at Task 14), and refresh `docs/STATUS.md` with what was
  verified where.

### Task 21: DoD for the branch

- [ ] `pnpm typecheck` clean, `pnpm test` green, `pnpm build:vps` completes.
- [ ] No `cloudflare:workers`, `@astrojs/cloudflare`, `@emdash-cms/cloudflare`,
  `hyperdrive`, `kvCache`, `routeRules` or `cacheCloudflare` left in `src/`,
  `plugins/`, `astro.config.mjs`:

```bash
grep -rnE "cloudflare:workers|@astrojs/cloudflare|@emdash-cms/cloudflare|routeRules|cacheCloudflare|kvCache|hyperdrive" src plugins astro.config.mjs package.json || echo "clean"
```

- [ ] `wrangler.jsonc` stays in the tree, commented as rollback-only, so the old
  Worker can be redeployed for 14 days.
- [ ] `docs/vps-runbook.md` exists and every owner command is one line.

---

## Self-review notes (author, 2026-11-24)

- Every PLAN.md route/feature has a task: routes are untouched (Task 7 keeps the
  middleware redirects); features 1–10 survive except the weather's server-side
  geolocation (Task 6) and the share cards' rasteriser (Task 11), both replaced.
- No placeholders: the only values not in the repo are the owner inputs listed at
  the top (zone id, tokens, port proof).
- Type consistency: `DrawOp`/`ShareLayout`/`ShareFormat`/`FontWeight` are the
  names `src/utils/share-card.ts` exports today; `PHOTO_OPACITY` moves from the
  route into `share-render.ts`; `tagsForPath`/`collectionsForPath` are defined in
  Task 5 and used in Tasks 7 and 9; `media-store` names (`getObject`,
  `putObject`, `deleteObject`) are used by Tasks 10 and 11.
- Known risk, flagged not hidden: **the share-card pixels** and the **baseline
  offset** (`+0.06`) need an eyeball against the live card (Task 11 step 3). The
  second is the search index being empty until step 3 of Task 16 runs.
- Deliberately out of scope: the `notify.checkclimate.africa` email domain moves
  with the apex zone (PLAN phase 10) and is unaffected; Turnstile keys and the
  Resend key are reused, not rotated.
