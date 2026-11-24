# Check Climate Africa: WordPress → Astro + EmDash

Status: plan v3, 2026-11-24. Stack moved from Cloudflare Workers (free) + Neon via
Hyperdrive + R2 + KV to the shared edgdmedia **VPS: Node + SQLite behind
Cloudflare, media still in R2**. Reason: the free account quotas (10 ms CPU per
request, 100k requests/day, Hyperdrive 100k queries/day, Neon ~191.9 compute
hours/month, KV 1,000 writes/day) are nearly spent for November. The Worker
stays deployed as the rollback until the owner says the box is final.
Migration plan: `docs/superpowers/plans/2026-11-24-vps-migration.md`; owner's
operating manual: `docs/vps-runbook.md`.
Owner: edgdmedia. Repo: github.com/edgdmedia/checkclimate.

## Goal

Replace the WordPress site at https://www.checkclimate.africa with an Astro + EmDash site that:

- follows the approved design (`design/`),
- keeps every existing URL working (SEO),
- runs on the owner's VPS (`169.58.2.239`) as one Node process behind nginx, with Cloudflare still the edge cache,
- keeps all media in Cloudflare R2 (unchanged bucket),
- needs no per-request quota accounting: database reads on the box are free.

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
  → Cloudflare zone cache (Cache Rule makes HTML eligible; purge by Cache-Tag)
    → nginx on 169.58.2.239 (Cloudflare IPs only via geo $realip_remote_addr, Origin Certificate)
      → 127.0.0.1:4331  node ./dist/server/entry.mjs   (systemd, user checkclimate, one process)
        → SQLite  /home/checkclimate/data/emdash.db (WAL) + EmDash memoryCache in-process
        → R2 `checkclimate-media`   media, over the S3 API (same bucket, same keys)
        → sessions /home/checkclimate/data/sessions (fsLite, outside the checkout)
        → in-process scheduler      scheduled publishing (no cron trigger anywhere)
```

`astro.config.mjs` (full detail in the migration plan, Tasks 4–9):

```js
import node from "@astrojs/node";
import emdash, { local, memoryCache, s3 } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  // No `cache:` and no `routeRules`: a provider makes EmDash skip its own query
  // cache and strips Cache-Tag. Caching is headers + the zone Cache Rule.
  session: { driver: sessionDrivers.fsLite({ base: process.env.SESSION_DIR }) },
  integrations: [
    emdash({
      database: sqlite({ url: `file:${process.env.DATABASE_PATH}` }),
      storage: s3(),                 // R2 over its S3 API; local() when S3_BUCKET is unset
      objectCache: memoryCache({ defaultTtl: 3600, revalidate: 0, maxEntries: 5000 }),
      trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      toolbar: "client",
      plugins: [/* resend-email, site-settings, post-editor, cloudflare-purge */],
    }),
  ],
});
```

### What each piece replaces

| Workers (plan v2) | The box (plan v3) | Why |
|---|---|---|
| `@astrojs/cloudflare`, `src/worker.ts` | `@astrojs/node` standalone | the 10 ms CPU cap and 100k requests/day are gone |
| Hyperdrive ×2 → Neon Postgres | SQLite file | no query quota, no compute hours, no transatlantic round trips; FTS search comes back |
| `kvCache(CACHE)` | `memoryCache` | one warm process is a real cross-request cache; KV's 1,000 writes/day is irrelevant |
| `sessionDrivers.cloudflareKVBinding(SESSION)` | `sessionDrivers.fsLite` | a deploy must not log editors out, so the store sits outside the checkout |
| `cacheCloudflare()` + `routeRules` + 16 `Astro.cache.set` hints | `Cache-Control` + `Cache-Tag` in middleware | Astro strips `Cache-Tag` when its provider serves the page, and a provider disables EmDash's query cache |
| EmDash's Workers-cache tag purge | `plugins/cloudflare-purge` → `POST /zones/:id/purge_cache` | the edge is now the only shared cache |
| Cron `*/15 * * * *` + `createScheduledHandler()` | the in-process scheduler | **delete the Worker's cron after cutover** or it keeps reading Neon |
| `env.IMAGES` for share cards | sharp + opentype.js (glyph paths) | no Images binding off-Workers |
| Postgres ILIKE search | EmDash `search()` (FTS5) | faster, and it is what the transfer import re-enables |
| Workers `ratelimits`, `caches.default` | `src/lib/kv-lite.ts` (TTL map) | one process, so a Map is honest |
| `r2({ binding: "MEDIA" })` | `s3()` + `src/utils/media-store.ts` | nothing to move: same bucket, same keys, same `/​_emdash/api/media/file/` URLs |

### Caching rules

- Middleware: public 200 → `public, max-age=300, s-maxage=2592000` + `Cache-Tag`
  (collections for the path + chrome + `all`); 404 → 60 s; `/_emdash/*`, `/admin`,
  `/search`, `/submit-a-claim`, any `astro-session` cookie → `private, no-store`;
  media files → 1 year `immutable`. No `stale-while-revalidate` (Cloudflare ignores
  it when `s-maxage` is present).
- A **zone Cache Rule is required**: Cloudflare never caches HTML by default.
  Eligible for cache, edge TTL "use cache-control header if present".
- Purge by tag works on the Free plan (5 requests/minute, so the plugin retries 429s
  and debounces draft autosaves).

### What the box costs

Nothing per read. The constraints move to the box itself: one process (SQLite has a
single writer and the scheduler must not run twice), the shared nginx/Virtualmin
setup (`conf.d/` wins over Virtualmin's vhost; `listen 169.58.2.239:443`), disk for
the database plus 14 days of backups, and the nightly `sqlite3 .backup` → private
R2 bucket (`checkclimate-backups`, rclone `no_head = true`). R2 stays free of
egress fees. Watch: `systemctl status checkclimate`, `journalctl -u checkclimate`,
and disk in the dashboard already on the box.

Rollback for 14 days: re-attach the custom hostname to the `checkclimate` Worker
(and its `www` redirect), keep Neon and the KV namespaces alive.

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
| 5 | Workers deploy wiring: caching, cron, Resend plugin, GitHub Actions, runbook | opencode | done, **superseded by the VPS plan** |
| 6 | Provision: R2 `checkclimate-media`, KV cache + session, Neon + Hyperdrive ×2 | owner | done; R2 stays, the rest retire after the rollback window |
| 7 | Deploy to workers.dev, then the apex | owner | done — live on checkclimate.africa |
| 8 | Content import (WordPress → Neon + R2), fix-up, verify | opencode + owner | done 2026-11-20 |
| 9 | Pilot on the free plan | owner | done: quotas nearly spent in month one → **migrate to the VPS** |
| 10 | VPS migration: Node + SQLite, edge cache, data copy, staging, cutover | opencode + owner | **in progress** — `docs/superpowers/plans/2026-11-24-vps-migration.md` |

## Content migration (posts, pages, images)

The WordPress import below **ran on 2026-11-20** and is kept as the record of how
the content got in. The current copy is a different one: Neon Postgres → SQLite,
through EmDash's site transfer, per the migration plan (Task 16). Same rule as
always: never run either import on the deployed Worker — the analyze/convert steps
exceed the free plan's 10 ms CPU (Error 1102) and a retry loop burns quotas. Both
ends of the transfer run from local `astro dev`:

1. Local dev uses Hyperdrive `localConnectionString` = **Neon prod branch** (direct URL) for the import session only, and the `MEDIA` R2 binding with `"remote": true`, so imported rows land in Neon and images land in the real R2 bucket.
2. On WordPress: install the **EmDash Exporter** plugin, create an application password, and allow `/wp-json/` (security plugin) for the import.
3. Locally at `/_emdash/admin/import/wordpress`: connect with the Exporter key, map `post → posts`, `page → pages`, authors → guest bylines, enable menus, SEO (Yoast), featured images, comments. Start the import, then the **media step** (downloads from `/wp-content/uploads`, stores in R2, rewrites content URLs).
4. Save the media `urlMap` to `migration/media-url-map.json`, which drives the `/wp-content/uploads/*` 301s.
5. `pnpm tsx scripts/unwrap-wayback.ts` (dry run default, `--apply` to write; needs `pnpm dev` running for media uploads). The old site was partly restored from the Wayback Machine, so content arrived with URLs wrapped as `https://web.archive.org/web/<timestamp><flag>/<original>`. Only wrapped URLs whose **original is on checkclimate.africa** are processed: own-site links become root-relative WordPress paths (`/tag/<slug>/`, old `/yyyy/mm/dd/slug/` permalinks), own-site images are pointed at the media-library copy in R2 — from the urlMap, or downloaded (live site first, then the Wayback `id_` raw copy, throttled to 1/s) and uploaded through EmDash's media API. External Wayback URLs are deliberate archived citations (fact-check evidence) and are left exactly as they are. Failures are listed in `migration/unwrap-wayback-failed.json`; a second run is idempotent.
6. `pnpm tsx scripts/post-import.ts` (idempotent by slug, `--dry-run` default, per-row report): set `kicker`, check `published_at` against the old date path, check the old `wayback_source_url` postmeta against each entry's permalink (from `migration/wayback-source-urls.json`, report only — the meta is never imported), flag leftover Elementor/shortcode markup and `wp-content` URLs, list fact checks needing claim/verdict.
7. `pnpm tsx scripts/verify-migration.ts`: counts (172 / 6 / 36 / 277), every URL in the old sitemap returns 200 on the workers.dev site, no `wp-content` URLs left in content, and no own-site Wayback URL left wrapped (external archived citations are expected, ~764).
8. Switch `localConnectionString` back to the Neon **dev** branch. Before the domain moves, re-run the import with `skipExisting` for posts written since.
9. Keep WordPress (DB + uploads) backed up for 30 days after the domain moves. **Never delete the R2 media bucket.**

## Deploys

- GitHub Actions: `dev` → typecheck, test, `pnpm build:vps`. `main` → SSH to the box as the `checkclimate` user, whose key is pinned to a forced `scripts/deploy-vps.sh` (pull `--ff-only`, `pnpm install --frozen-lockfile`, source `/etc/checkclimate.build.env`, `pnpm build:vps`, restart, smoke-test `127.0.0.1:4331`). Then **purge everything at the edge** — the purge plugin only fires on content changes, so a template fix would otherwise hide behind 30-day cached pages. Secrets: `VPS_HOST`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `CLOUDFLARE_PURGE_TOKEN`.
- The old Workers pipeline is parked as `.github/workflows/deploy-workers.yml.disabled` for the rollback window.
- Runtime config lives in `/etc/checkclimate.env` (root 600, mode 600: `EMDASH_ENCRYPTION_KEY`, `RESEND_API_KEY`, `TURNSTILE_*`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`). Values never in the repo. **`EMDASH_ENCRYPTION_KEY` must stay the value the Worker uses** — the plugin settings copied by the transfer are ciphertext sealed with it.
- First boot runs EmDash migrations on the SQLite file; the service must stay a single process.

## Open items

- Cutover, staging checks and the owner's server steps: `docs/superpowers/plans/2026-11-24-vps-migration.md` Tasks 17–21; the manual is `docs/vps-runbook.md`.
- Keep the Worker, Hyperdrive, KV and Neon for 14 days after cutover as the rollback; delete the Worker's **cron triggers** at cutover; never delete the R2 media bucket.
- Domain is already apex `checkclimate.africa` with `www` redirecting; `media.` subdomain was never needed (media serves through `/​_emdash/api/media/file/`).
- Email sending domain `notify.checkclimate.africa` (Resend) is unaffected by the move.
