# Task: re-target to Workers + Neon, then finish phases 3–5

The stack changed. Read `AGENTS.md` and `docs/PLAN.md` (v2) first. Phases 1–2 were built for Node + SQLite; phase 3 work is uncommitted on `dev`. Keep working on `dev`. Commit after each step below. Don't push. Don't deploy.

## Step A — Re-target the scaffold (commit: "Re-target to Cloudflare Workers + Neon via Hyperdrive")

- Swap `@astrojs/node` for `@astrojs/cloudflare`; remove `sqlite`, `s3`, `local`, `memoryCache`, `fsLite` sessions, `@libsql/client`, `@aws-sdk/*`, `trustedProxyHeaders`.
- `astro.config.mjs` as in PLAN.md "Architecture" (`hyperdrive` with `cachedBinding`, `r2`, `kvCache` 86400, `cacheCloudflare()`, `routeRules`, `toolbar: "client"`). Check the current option names in Context7 `/websites/emdashcms` (pages: reference/configuration, deployment/cloudflare, deployment/database, deployment/object-cache, route caching) before writing.
- Add `pg` (≥ 8.16.3) and `wrangler` (dev dep).
- `wrangler.jsonc`: name `checkclimate`, `main` `./src/worker.ts`, `compatibility_flags: ["nodejs_compat"]`, `account_id` and binding ids read from `.cf-ids.json` if present (otherwise placeholders `REPLACE_ME`; Claude fills them in), `hyperdrive` HYPERDRIVE + HYPERDRIVE_CACHED with `localConnectionString` from env `NEON_DEV_DATABASE_URL`, `r2_buckets` MEDIA → `checkclimate-media`, `kv_namespaces` CACHE (`kv_cache_id`) and SESSION (`kv_session_id`, Astro sessions), `triggers.crons: ["*/15 * * * *"]`, `placement` near Frankfurt (check the current Wrangler syntax for targeted placement), `workers_dev: true`, `observability.enabled: true`.
- `src/worker.ts`: Astro handler + `scheduled` from `@emdash-cms/cloudflare/worker` (the form `emdash doctor` recognises).
- Seed scripts: target Postgres via `NEON_DEV_DATABASE_URL` (check the EmDash CLI docs for seeding a Postgres/Hyperdrive project). Drop the SQLite-specific `fix-dates.mjs` if it no longer applies, or port it to Postgres.
- `.env.example`: `NEON_DATABASE_URL` (prod, direct), `NEON_DEV_DATABASE_URL` (dev branch, direct), `EMDASH_ENCRYPTION_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `CLAIMS_INBOX`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`. Also `.dev.vars.example` for the Worker secrets.
- Delete VPS leftovers (`uploads/`, `data/` usage, node start script). `pnpm build` must pass. If `.env` has `NEON_DEV_DATABASE_URL`, run the seed and confirm `pnpm dev` renders the home page; if not, say so in STATUS.md and continue.

## Step B — Phase 3: layout, components, templates

As in the previous task: BaseLayout (SEO, og image width/height, theme no-flash, skip link), Header, Footer, all components in `design/system/project/components/*` plus AlertBanner, FactCheckBand, ClaimCard, VerdictPanel, ShareBar, Breadcrumb, TagList, Pagination; every route in PLAN.md "Routes"; Portable Text (h2, pull quote, lists, links, figure + caption, YouTube/X embeds); light/dark; responsive at 1440/900/600/360. Add a `routeRules` entry + cache hints for each public route. Paginate lists, and select only needed fields.

## Step C — Phase 4: dynamic features

Weather island (client-side Open-Meteo), claim form (`claims` entry, R2 upload, Turnstile server-side, Resend email, zod with `.nullish()`), EmDash comments with Turnstile, search (uncached), RSS at `/feed/` and per category, sitemap + `/sitemap_index.xml` redirect, robots.txt, redirects middleware (`/wp-admin*`, `/wp-login.php`, `/login` → `/admin/`; `/wp-content/uploads/*` → lookup in a bundled `migration/media-url-map.json`, empty for now; `/megamenu/*` → 410), branded `/admin/` page (noindex meta + `X-Robots-Tag`), site-settings plugin over hardcoded defaults.

## Step D — Phase 5: Workers deploy wiring (don't deploy)

- `plugins/resend-email/` native email transport (reads the key via `import { env } from "cloudflare:workers"` in its own `env.mjs`), vitest with mocked fetch.
- `.github/workflows/ci.yml` (dev: install, typecheck, test, build) and `deploy.yml` (main: build + `wrangler deploy`, secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
- `scripts/post-import.ts` and `scripts/verify-migration.ts` per PLAN.md "Content migration" 5–6, connecting directly to Neon with `pg` (dry-run default, per-row report).
- `docs/RUNBOOK.md`: resources and binding names, secret names, how to switch `localConnectionString` between dev and prod branches for the import, migration-lock fix (`UPDATE _emdash_migrations_lock SET is_locked = 0` via psql), quota dashboards to watch (1102 errors, Hyperdrive queries, Neon CU-hours, KV writes), rollback.

## Finish

`pnpm build`, `pnpm typecheck`, `pnpm test` all pass. If the Neon dev URL is available, run `pnpm preview` and curl every route (200s; 404 for a missing slug). Update `docs/STATUS.md`: what's built, what was verified and how, what's stubbed, deviations from the design and why.
