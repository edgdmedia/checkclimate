# Check Climate Africa: WordPress → Astro + EmDash

Status: plan v2, 2026-11-19. Stack changed from VPS to **Cloudflare Workers (free) + Neon via Hyperdrive + R2 + KV**.
Owner: edgdmedia. Repo: github.com/edgdmedia/checkclimate.

## Goal

Replace the WordPress site at https://www.checkclimate.africa with an Astro + EmDash site that:

- follows the approved design (`design/`),
- keeps every existing URL working (SEO),
- runs on Cloudflare Workers (free plan) in the Security Focus Cloudflare account, with no server to maintain,
- keeps all media in Cloudflare R2.

For now the site lives on its `*.workers.dev` URL. Later it moves to `checkclimate.africa` (apex, no www).

## What exists today (measured 2026-11-19)

| Item | Count / fact |
|---|---|
| Posts | 172 (Yoast `post-sitemap.xml`) |
| Pages | 6: `/`, `/posts/`, `/contact-us/`, `/accessibility-statement/`, `/about-us/`, `/privacy-policy-2/` |
| Categories | 36 (nav uses 7: Agriculture, Aviation, Environment, Fact Check, Green Energy, News, Sustainability) |
| Tags | 277 |
| Images in posts | about 250, under `/wp-content/uploads/YYYY/MM/` |
| Permalinks | `/YYYY/MM/DD/<slug>/`, `/category/<slug>/`, `/tag/<slug>/` |
| Theme / builder | Blogar + Elementor; weather widget from the custom `edgd-weather` plugin |
| SEO | Yoast |
| Public REST API | `/wp-json/*` returns 403 today; the owner will open it for the EmDash Exporter |
| Edge | Served straight from nginx, not proxied by Cloudflare |

## Design sources (in this repo)

| Path | What |
|---|---|
| `design/system/project/README.md` | Brand book: voice, colour rules, type, shape, logo rules |
| `design/system/project/tokens.json` | All tokens (light + dark). Source of truth for CSS variables |
| `design/system/project/components/*/README.md` + `bundle.css` | Component specs (cc- classes) |
| `design/pages/project/*.dc.html` | Page designs: Main (home), Article, FactCheck, Category (archive), About (+Contact), SubmitClaim, Header, Footer |
| `design/pages/project/canvas.json` | Notes on what changed vs the live site |
| `design/logos/*` | Logo files. In the page designs, `/_blob/6d94b35f…` = `check-climate-lockup.png`, `/_blob/6dab08b1…` = `check-climate-lockup-reverse.png`, `/_blob/33927b83…` = `check-climate-mark-simple.png` |

The `.dc.html` files are mockups (custom format with `{{holes}}`, `<sc-for>`, `<dc-import>`). Read them for layout, spacing and copy, then rebuild as Astro components. Don't ship them.

## Architecture

```
Browser
  → Workers Cache (cacheCloudflare + routeRules; EmDash purges by tag on publish)
    → Worker `checkclimate` (Astro 7 + EmDash, @astrojs/cloudflare, placement near Neon)
      → KV `CACHE`          object cache (kvCache, long TTL)
      → Hyperdrive          HYPERDRIVE (caching off: admin, writes)  +  HYPERDRIVE_CACHED (anonymous reads)
          → Neon Postgres   project `checkclimate`, aws-eu-central-1 (Frankfurt)
      → R2 `checkclimate-media`   media (later on media.checkclimate.africa)
      → Cron */15 * * * *         scheduled publishing
```

`astro.config.mjs`:

```js
import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import emdash from "emdash/astro";
import { hyperdrive, r2, kvCache } from "@emdash-cms/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  cache: { provider: cacheCloudflare() },
  routeRules: { /* public routes only, see "Caching" */ },
  integrations: [
    emdash({
      database: hyperdrive({ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" }),
      storage: r2({ binding: "MEDIA" /* publicUrl: "https://media.checkclimate.africa" once the zone is on Cloudflare */ }),
      objectCache: kvCache({ binding: "CACHE", defaultTtl: 86400 }),
      toolbar: "client",
      plugins: [/* resend-email, site-settings */],
    }),
  ],
});
```

`wrangler.jsonc` (account = **Security Focus**, `9c8aaa232a52d145430685011e9fff9c`; shared free quotas with other projects in that account): `nodejs_compat`, `hyperdrive` ×2 (with `localConnectionString` to a Neon **dev** branch), `r2_buckets` MEDIA, `kv_namespaces` CACHE (`kv_cache_id`) and SESSION (`kv_session_id`, Astro sessions), `triggers.crons: ["*/15 * * * *"]`, `placement` near Frankfurt, `workers_dev: true`, `observability` on. Entry `src/worker.ts` re-exports the `scheduled` handler from `@emdash-cms/cloudflare/worker`. Requires `pg` ≥ 8.16.3. Verify with `emdash doctor`.

### Why two Hyperdrive bindings

The EmDash docs recommend a primary binding with caching **disabled** (admin, logged-in requests, writes, migrations) and a cached binding on the same database for anonymous public reads. That keeps editors from seeing stale data and still lets most public reads skip Neon.

### Caching

- **Workers Cache** in front of the Worker via `cacheCloudflare()`. Every public route gets a `routeRules` entry (lifetime + tags); EmDash purges by tag on publish. Never cache `/_emdash/*`, `/admin`, form POSTs, search, or anything session-dependent. Don't use a root `/[...slug]` rule (it would match `/_emdash/`).
- Guard every hint: `if (Astro.cache?.enabled && hint) Astro.cache.set(hint)`. Dev has caching off, so cache code is only verified on a deployed Worker.
- If Workers Cache isn't available on the free account, fall back to the Cache API in outer middleware, purged on publish.
- **KV object cache** with a 24h TTL. KV free allows **1,000 writes a day**, so keep TTLs long and don't write per request.

### Free-plan limits and how we watch them

| Limit (free) | Mitigation | Watch |
|---|---|---|
| Workers 100k requests/day (per account) | Own account for this client; cached pages use almost no CPU | Workers analytics |
| **Workers 10 ms CPU per request** | Page cache; heavy jobs (import) run locally, never on the Worker | **Error 1102 / exceededCpu** on uncached pages and the admin |
| Hyperdrive 100k queries/day | Only cache misses reach the DB | Hyperdrive dashboard |
| Neon 100 CU-hours/month, 1 GB storage | Scales to zero; media is in R2 | Neon console |
| KV 1,000 writes/day | Long TTLs | KV metrics |
| R2 10 GB, no egress fees | Fixed set of image sizes | R2 metrics |

Pilot gate: run a few days on workers.dev with real content and crawler traffic. If 1102 errors appear on uncached pages, the fallback is Turso via `libsql()` with indexes on category/tag queries (after confirming it runs on Workers).

## Content model

**Collection `posts`** (news + fact checks together, so URLs and archives stay unified)
- `title`, `slug`, `excerpt`, `content` (Portable Text), `featured_image`, `published_at`, bylines
- `kicker`: select `none | alert | fact_check` (from the `ALERT:` / `FACT CHECK:` title prefix on import)
- Fact-check fields (shown only when `kicker = fact_check`): `claim`, `claim_source`, `verdict` (False, Misleading, False context, Partly true, True, Unproven), `verdict_summary`, `verdict_note`, `sources` (Portable Text)
- `at_a_glance` (optional list), SEO fields (filled from Yoast by the Exporter)

**Collection `pages`**: `title`, `slug`, `content`, `featured_image`, SEO fields.

**Collection `claims`** (private): `claim`, `platform`, `country`, `link`, `attachment`, `name`, `email`, `consent`, `status` (new / checking / published / rejected), `notes`.

**Taxonomies**: `category` (keep WP slugs), `tag` (keep WP slugs). **Menus**: `primary`, `footer`. **Site settings** (native plugin `ctx.settings` over hardcoded defaults): contact email, socials, weather default city.

## Routes (keep the WordPress URLs)

| Route | Template | Design |
|---|---|---|
| `/` | Home | Main |
| `/[yyyy]/[mm]/[dd]/[slug]/` | Article or Fact check (by `kicker`) | Article / FactCheck |
| `/category/[slug]/` (+ `/page/[n]/`) | Archive; Fact Check gets topic filters (`?topic=`, server-side) | Category |
| `/tag/[slug]/`, `/author/[slug]/`, `/posts/` | Archives | Category |
| `/about-us/`, `/contact-us/` | About + Contact | About |
| `/submit-a-claim/` | Claim form + thank-you | SubmitClaim |
| other pages (`/privacy-policy-2/`, `/accessibility-statement/`) | Generic page | Article prose |
| `/search/?q=` | Search (not cached) | Category |
| `/feed/`, `/category/[slug]/feed/` | RSS | — |
| `/sitemap.xml` (+ `/sitemap_index.xml` → it), `/robots.txt` | — | — |
| `/admin/` | Branded editor landing → `/_emdash/admin` (noindex) | — |
| `/wp-admin*`, `/wp-login.php`, `/login` | 302 → `/admin/` | — |
| `/wp-content/uploads/*` | 301 to the R2 media URL (map from the import `urlMap`, stored in KV-free form: a JSON module bundled at build) | — |
| `/megamenu/*` | 410 | — |

## Features

1. Header: top bar (date, weather, Light/Dark), logo + strapline, search, "Submit a claim", category nav, mobile menu.
2. Weather island (replaces `edgd-weather`): Open-Meteo, geolocation, default city (Lagos), 30-min `localStorage` cache. Client-side, so cached pages stay cacheable.
3. Light/Dark: `data-theme` on `<html>`, `localStorage`, `prefers-color-scheme`, no-flash inline script, logo swap.
4. Home: hero + list, Top Stories tabs, ALERT banner, Fact-check band with claim card, News grid, category blocks.
5. Article: breadcrumb, share bar (Facebook, X, LinkedIn, WhatsApp, copy), At a glance, pull quotes, tags, corrections mailto, comments, related.
6. Fact check: Claim / Verdict panel, sources, share, More fact checks.
7. Archives with pagination, author/date/reading time.
8. Submit a claim → `claims` entry, upload to R2, Turnstile (server-side verify), Resend email to the desk.
9. Comments: EmDash comments, moderated, Turnstile.
10. Back-to-top, focus styles, 4.5:1 contrast per the tokens README.

## Phases

| # | Phase | Who | State |
|---|---|---|---|
| 1 | Scaffold | opencode | done for Node/SQLite; **re-target to Workers** |
| 2 | Schema + seed | opencode | done |
| 3 | Layout, components, templates | opencode | in progress (uncommitted work kept) |
| 4 | Dynamic features | opencode | todo |
| 5 | Workers deploy wiring: caching, cron, Resend plugin, GitHub Actions, runbook | opencode | todo |
| 6 | Provision: R2 `checkclimate-media`, KV `checkclimate-cache` + `checkclimate-session` (done, ids in `.cf-ids.json`); Neon prod + dev branches, Hyperdrive ×2, secrets | Claude | Neon waiting on `neonctl auth` |
| 7 | First deploy to workers.dev with seed | Claude | todo |
| 8 | Content import (local → Neon prod + R2), fix-up, verify | Claude + owner | todo |
| 9 | Pilot: watch 1102 errors, Hyperdrive queries, Neon CU-hours for a few days | Claude + owner | todo |
| 10 | Domain: move zone to CF, apex `checkclimate.africa`, www→apex, `media.` for R2 | later | todo |

## Content migration (posts, pages, images)

**Rule: never run the import on the deployed Worker.** The import's analyze/convert steps exceed the free plan's 10 ms CPU (Error 1102), and a retry loop burns quotas. Run it from local `astro dev`, which has no CPU cap, with bindings pointed at the real resources:

1. Local dev uses Hyperdrive `localConnectionString` = **Neon prod branch** (direct URL) for the import session only, and the `MEDIA` R2 binding with `"remote": true`, so imported rows land in Neon and images land in the real R2 bucket.
2. On WordPress: install the **EmDash Exporter** plugin, create an application password, and allow `/wp-json/` (security plugin) for the import.
3. Locally at `/_emdash/admin/import/wordpress`: connect with the Exporter key, map `post → posts`, `page → pages`, authors → guest bylines, enable menus, SEO (Yoast), featured images, comments. Start the import, then the **media step** (downloads from `/wp-content/uploads`, stores in R2, rewrites content URLs).
4. Save the media `urlMap` to `migration/media-url-map.json`, which drives the `/wp-content/uploads/*` 301s.
5. `pnpm tsx scripts/post-import.ts` (idempotent by slug, `--dry-run` default, per-row report): set `kicker`, check `published_at` against the old date path, flag leftover Elementor/shortcode markup and `wp-content` URLs, list fact checks needing claim/verdict.
6. `pnpm tsx scripts/verify-migration.ts`: counts (172 / 6 / 36 / 277), every URL in the old sitemap returns 200 on the workers.dev site, no `wp-content` URLs left in content.
7. Switch `localConnectionString` back to the Neon **dev** branch. Before the domain moves, re-run the import with `skipExisting` for posts written since.
8. Keep WordPress (DB + uploads) backed up for 30 days after the domain moves. **Never delete the R2 media bucket.**

## Deploys

- GitHub Actions: `dev` → typecheck, test, build. `main` → `pnpm astro build && pnpm wrangler deploy` (always build first: deploy reads `dist/server/wrangler.json`). Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Worker secrets (names in `docs/RUNBOOK.md`, values never in the repo): `EMDASH_ENCRYPTION_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`. Run `wrangler secret list` after any Worker create/rename.
- First boot runs EmDash migrations on Neon. Deployment migrations use the direct Neon URL (`migrationConnectionStringEnv`).

## Open items

- VPS: not used any more.
- Domain move and email sending domain: later (phase 10).
