# Status — Check Climate Africa rebuild

Last updated: 2026-11-20, after the Wayback unwrap pass. Branch `dev`,
five commits, nothing pushed, nothing deployed.

| Commit | Step |
|---|---|
| `a07de0d` | A — Re-target to Cloudflare Workers + Neon via Hyperdrive |
| `98d5358` | B — Phase 3: design system, page routes and edge caching |
| `00ff1d7` | C — Phase 4: claim form, comments, feeds, redirects and site settings |
| `943f3cc` | D — Phase 5: deploy wiring, migration scripts, plugins, tests, runbook |
| (this commit) | Wayback unwrap pass — see "Wayback unwrap pass" below |

## What is built

**Stack.** Astro 7 + EmDash 1.5 on Cloudflare Workers (free plan), Neon
Postgres through two Hyperdrive configs (`HYPERDRIVE` uncached for
writes/admin, `HYPERDRIVE_CACHED` for public reads), R2 `MEDIA`, KV `CACHE`
(object cache, 86400 s TTL) and `SESSION`. `src/worker.ts` exports the Astro
handler plus EmDash's `scheduled` (cron `*/15 * * * *`). Placement
`aws:eu-central-1` next to Neon Frankfurt; observability on; `workers_dev`
on. Real Hyperdrive ids from `.cf-ids.json` are now in `wrangler.jsonc`
(they were `REPLACE_ME` until the Finish pass). No D1, no SQLite, no
`@astrojs/node`, no VPS files.

**Design system (Phase 3).** CSS custom properties generated from
`design/system/project/tokens.json` (`scripts/build-tokens.mjs`), light on
`:root`, dark on `[data-theme="dark"]` with a no-flash inline script.
Red Hat Display self-hosted via `@fontsource`. Logos copied from
`design/logos/` (light + reverse lockup). All components from the design
system plus AlertBanner, FactCheckBand, ClaimCard, VerdictPanel, ShareBar,
Breadcrumb, TagList, Pagination. Inline stroke SVG icons, no emoji.
Contrast rules honoured: small green text is `brand-forest`, amber is a
fill with black text, `leaf` only for fills/icons/large text. Breakpoints
900/600 px; pages work at 360 px.

**Routes.** Every route in PLAN.md: home, `/posts/` + `/posts/page/[n]/`,
`/[yyyy]/[mm]/[dd]/[slug]/` articles, `/category/[slug]/` (+ paginated),
`/tag/[slug]/`, `/author/[slug]/`, the four pages (`/about-us/`,
`/contact-us/`, `/privacy-policy-2/`, `/accessibility-statement/`),
`/search/`, `/submit-a-claim/`, `/feed/`, `/category/[slug]/feed/`,
EmDash's `/sitemap.xml` + per-collection sitemaps + `/robots.txt`,
`/sitemap_index.xml` → `/sitemap.xml` redirect, branded noindex `/admin/`
door to `/_emdash/admin`, custom 404. Every public route has a
`routeRules` entry and a guarded cache hint
(`if (Astro.cache?.enabled && hint) Astro.cache.set(hint)`). Search, the
claim form, `/admin`, `/_emdash/*` and all POSTs are never cached. Lists
are paginated (offset-based; EmDash returns `hasMore`, not totals, so
numbered links have no "last page").

**Dynamic features (Phase 4).**
- Claim form: zod with `.nullish()`, honeypot, server-side Turnstile
  siteverify, attachment → R2 `put` → media-library row → one `claims`
  draft entry; failed save cleans up the attachment; success 303 to
  `?status=sent`; rejection 400 with echoed values and field errors.
  Desk notification via Resend REST (`src/utils/email.ts`); the form
  still succeeds when mail is unconfigured or fails.
- Comments: EmDash's comment system with Turnstile, themed
  `src/components/Comments.astro` (pending-review state included).
- Weather: client-side Open-Meteo island, city/coordinates from site
  settings; degrades to a static label when the fetch fails.
- Redirects middleware: `/login`, `/wp-admin*`, `/wp-login.php` → 301
  `/admin/`; `/megamenu/*` → 410; `/wp-content/uploads/*` → lookup in
  `migration/media-url-map.json` (empty until the import); canonical
  trailing-slash 301s. Missing slugs return a direct 404 (no redirect
  chain — `/404` is excluded from the slash rule).
- RSS: full-text `<content:encoded>` via a Portable Text → HTML
  serializer that strips script/style/iframe/event handlers and unsafe
  link schemes; per-category feeds.

**Plugins (Phases 4–5).** Two native EmDash plugins, registered in
`astro.config.mjs` as plain descriptors and resolved by Vite aliases
derived from the same list:
- `plugins/site-settings` — admin form for contact email, claim inbox,
  five social profiles, weather city/country/lat/lon. Read through
  `src/utils/site.ts` (60 s per-isolate cache, defaults in
  `src/utils/site-settings.ts`). `CLAIMS_INBOX` Worker var pins the inbox
  above the form. An empty string hides a social profile; clearing all
  of them shows none.
- `plugins/resend-email` — exclusive `email:deliver` hook so EmDash's own
  mail (magic links, invites, comment notices) actually sends. Reads
  `RESEND_API_KEY`/`EMAIL_FROM` via `import { env } from "cloudflare:workers"`
  in its own `env.mjs`; the transport is a plain function, unit-tested
  with a mocked fetch.

**Deploy wiring (Phase 5).** `.github/workflows/ci.yml` (dev + PRs:
install, typecheck, test, build, `wrangler deploy --dry-run`) and
`deploy.yml` (main: typecheck, test, `pnpm astro build && pnpm wrangler
deploy`, secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`, then
`wrangler secret list` as a sanity check). Neither has run — nothing is
pushed.

**Migration scripts (Phase 5).** `scripts/post-import.ts` and
`scripts/verify-migration.ts`, both direct `pg` to Neon
(`--database=dev|prod`), dry-run by default, per-row reports, idempotent
by slug. post-import auto-fixes only the kicker (title prefix or Fact
Check category); it reports publish-date mismatches against the old
WordPress URL paths, leftover Elementor/shortcode/`wp-content` markup,
fact checks missing claim/verdict, empty bodies, missing categories and
unpublished rows — all for a human, because guessing at content is how
migrations lose sentences. verify-migration checks published counts
against 172/6/36/277, scans content for `wp-content`/`wp-includes`, and
requests every old-sitemap URL against `--base` (8 concurrent, follows
redirects, 200 required); exits non-zero on any blocking finding.

**Docs.** `docs/RUNBOOK.md`: bindings, secrets and rotation, settings
editing, the import playbook (env-var override of the Hyperdrive local
connection string, not a wrangler.jsonc edit), the migrations-lock fix,
quota dashboards (1102s, Hyperdrive queries, Neon compute hours, KV
writes), rollback, backups.

## What was verified, and how

All on the Neon **dev** branch with seed data (16 posts, 4 pages, 11
categories, 24 tags, 2 bylines, 2 media rows, WordPress-style publish
dates).

- `pnpm typecheck`: 0 errors (66 files). `pnpm test`: 30 tests, 3 files
  (Resend transport, site-settings merge rules, Portable Text serializer).
  `pnpm build`: Complete. `pnpm exec wrangler deploy --dry-run`: bundle
  builds, all bindings resolve.
- `pnpm preview` (Astro preview on workerd, the real Worker runtime,
  Hyperdrive pointed at Neon dev via `scripts/with-env.mjs`) + curl:
  - 200: `/`, `/posts/`, `/posts/page/2/`, `/posts/page/3/`, three seeded
    article URLs, `/category/fact-check|news|agriculture/`,
    `/tag/climate-action/`, `/author/check-climate-desk/`,
    `/author/lanre-adebayo/`, all four pages, `/search/` and
    `/search/?q=flood`, `/submit-a-claim/`, `/feed/` (16 items,
    `<content:encoded>` present, no `<script>`),
    `/category/fact-check/feed/` (6 items), `/sitemap.xml` →
    `sitemap-posts.xml`/`sitemap-pages.xml`, `/robots.txt` (Disallow
    `/_emdash/`, Sitemap line), `/admin/` (+ `X-Robots-Tag: noindex,
    nofollow`).
  - 301: `/login`, `/wp-admin/`, `/wp-admin/profile.php`, `/wp-login.php`
    → `/admin/`; `/about-us` → `/about-us/`; `/feed` → `/feed/`;
    `/sitemap_index.xml` → `/sitemap.xml`.
  - 410: `/megamenu/x`. 404: `/no-such-page/`, `/tag/does-not-exist/`,
    `/category/nope/`, `/author/nobody/`, `/2025/01/01/no-such-article/`,
    unmapped `/wp-content/uploads/...`.
- Comment API: POST `/_emdash/api/comments/posts/<id>` with
  `{authorName, authorEmail, body, turnstileToken}` → 201
  `{"status":"pending"}`; without the token → 403 `TURNSTILE_FAILED`
  (server-side verification is live). Test comment deleted afterwards.
- Settings round-trip: inserted `options` rows → home rendered
  `data-city="Accra"` with the new coordinates, X/Twitter hidden, footer
  mailto changed. Test rows deleted afterwards.
- post-import: cleared one seeded kicker, dry run reported
  `[would fix] … unset → fact_check`, `--apply` wrote it, a second dry
  run reported nothing (idempotent). Row restored to its seed value.
- verify-migration: against seed data it correctly fails the counts
  (16/172, 4/6, 11/36, 24/277 — the real import has not run), finds 0
  `wp-content` leftovers, collected 178 URLs from the live WordPress
  sitemaps, and with `--urls` + `--base=http://localhost:4321` reported
  2 ok / 1 failed (the deliberately missing slug). Exit code 1 on
  blocking findings, as designed.
- Both plugins are in the built Worker bundle (`email:deliver` and
  `api.resend.com` in the middleware chunk; site-settings in its own).

## What is stubbed / not done

- **The real WordPress import has not run.** It needs the WP export and
  an admin session at `/_emdash/admin/import/wordpress`; the playbook is
  in the RUNBOOK. Until then: `migration/media-url-map.json` is empty
  (uploads redirects 404), `migration/old-urls.json` does not exist (the
  publish-date check is skipped), and verify-migration's counts fail by
  design against seed data.
- **Secrets are placeholders.** `.env` has empty/test values;
  `RESEND_API_KEY` was never exercised against the real API (the
  transport is unit-tested with mocked fetch). Turnstile uses
  Cloudflare's always-pass test keys in dev, so the 201/403 comment
  checks prove the wiring, not a real captcha solve.
- **No deploy.** Per the task, nothing was pushed or deployed; the
  workers.dev URL does not exist yet, so the live-URL check was run
  against the local preview instead.
- **Cloudflare Images (`IMAGES`)** is bound but unused; media is served
  from R2 through EmDash's media file route.
- **Numbered pagination has no last page** (EmDash offset queries return
  `hasMore`, not totals). Next/prev + numbered links up to the known
  range only.
- **Weather island** fetches Open-Meteo in the browser; the fallback
  label was verified, a live API fetch was not part of the checks.

## Deviations from the plan/design, and why

1. **Workers + Neon only.** `docs/opencode-task.md` Step A overrides
   PLAN.md's VPS option; all VPS/SQLite/Node-adapter files are gone.
2. **Local plugins via Vite alias**, not a pnpm workspace package: the
   descriptor in `astro.config.mjs` is plain data (no EmDash import in
   the config), and the alias map is derived from the same list so id,
   entrypoint and path cannot drift.
3. **Search is custom parameterised Postgres ILIKE**
   (`src/utils/search.ts`): EmDash's `search()` throws "Full-text search
   is only available with SQLite databases" on Postgres.
4. **Portable Text → HTML serializer rewritten** to match EmDash's
   actual converter output (block-level `markDefs`, `listItem`/`level`
   lists, `asset.url`/`asset._ref` images, `htmlBlock`/`iframe`/`gallery`
   types) after the first version's assumptions failed tests written
   against the real shapes.
5. **Claim desk mail goes direct to Resend** (`src/utils/email.ts`)
   rather than through the plugin hook: the form needs the send result
   synchronously and must succeed even when mail fails. The plugin
   covers EmDash's own background mail.
6. **post-import auto-fixes only the kicker.** Everything else is a
   report for an editor; silent content rewrites during a migration are
   how sentences get lost.
7. **Site-settings semantics:** absent → default, `""` → deliberately
   hidden, value → use it. Clearing every social profile shows none (no
   fallback to defaults), because the empty string is an explicit
   editor action.
8. **`/admin/` is a branded door**, not the CMS: the EmDash admin lives
   at `/_emdash/admin`; the door is noindex (meta + header) and links
   there.
9. **Node 22 vs engines >=24:** the local shell runs Node 22.23.4; pnpm
   warns "Unsupported engine" but typecheck, tests and build all pass.
   CI uses `.nvmrc` (24).
10. **RUNBOOK corrections during Finish:** worker name is `checkclimate`
    (not `checkclimate-africa`), Security Focus account id is
    `9c8aaa232a52d145430685011e9fff9c`, both Hyperdrive configs point at
    Neon **main** (local dev overrides via env vars), and the import
    switch is the `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` env
    vars, not a `wrangler.jsonc` edit.

## Wayback unwrap pass (2026-11-20, after the Finish checks)

Implements `docs/opencode-task-wayback.md`: own-site Wayback Machine URLs
in imported content are unwrapped; external archived citations are kept
verbatim.

**What was added**

- `scripts/lib/wayback.ts` — the shared helpers: `unwrapWayback` (parses
  `web.archive.org/web/<14 digits><flag>/<original>`, normalises `https:/` →
  `https://`, unwraps nested wrappers, leaves `archive.ph`/`archive.today`
  originals untouched — they are citations, not wrappers), own-host and
  image-original predicates, root-relative path mapping, the media-urlMap
  lookup (exact → base → WordPress size variant, across www/apex/http) and a
  Portable Text walker (`markDefs[].href`, image `asset.url`/`_ref`, linked
  images, galleries, columns, tables, buttons, files, embeds, htmlBlocks,
  video/iframe, featured image) that collects every wrapped URL with its
  container for in-place rewrites.
- `scripts/lib/wayback.test.ts` — unit tests for all of the above (the
  wrapper shapes measured on the live site: flags, single-slash originals,
  nesting, archive.ph, query strings, malformed wrappers).
- `scripts/unwrap-wayback.ts` — the pass itself. Dry run by default,
  `--apply` to write; `--database=dev|prod`, `--slugs=`, `--map=`,
  `--failed=`, `--media-url=`. Own-site links become root-relative WordPress
  paths (kept by our routes); own-site images resolve through
  `migration/media-url-map.json` first, otherwise download (live site, then
  the Wayback `id_` raw copy — throttled to 1 request/second, retried on
  429/5xx) and upload through EmDash's media API via the emdash CLI (never
  direct to R2), deduped per original URL; `srcset` is dropped; the block is
  rewritten with `meta.storageKey` the way imported images look. Failures
  leave the URL untouched and go to `migration/unwrap-wayback-failed.json`
  (gitignored run artifact); every run retries them. A second run finds
  nothing to change.
- `verify-migration.ts` gained check 2b: any own-site original still wrapped
  blocks the go/no-go decision unless it is on the FAILED list (reported as
  skipped — the next unwrap run retries it). External Wayback URLs are
  counted as expected citations, never blocking. `--unwrap-failed=` points
  somewhere else if needed.
- `post-import.ts` gained the `wayback_source_url` check (report only, the
  meta is never imported): when the owner saves the old postmeta to
  `migration/wayback-source-urls.json` (object, `{slug,url}` array or bare
  lines), each stripped Wayback URL is compared with the entry's own
  permalink and mismatches are reported.
- `package.json`: `pnpm unwrap-wayback`. `tsconfig.json` now typechecks
  `scripts/` too, so `@types/pg` is a dev dependency and `migration-db.ts`
  casts pg's `ssl.mode` (pg's types predate pg-connection-string; the
  runtime accepts it — the libpq "prefer/require" warning on stderr is
  benign).

**Decisions and incidents**

- `seed-db.ts` keeps the `--schema-only` flag and the `emdash:seed_complete`
  options insert (added on request; the insert mirrors EmDash's
  `claimExplicitSeedOwnership` so a fresh database does not fall into the
  auto-seed path and fail media activation).
- `scripts/tmp-smoke.ts` (a clearly-marked temporary smoke fixture) was
  removed, and its leftovers were cleaned: the `__wayback_smoke_test__` post
  was deleted from the **dev** branch (17 → 16 posts), the two fake
  `01SMOKEMEDIA*` entries the smoke run had put into
  `migration/media-url-map.json` were reverted to `{}`, the empty
  `migration/no-such-map.json` and the stale smoke-era
  `migration/unwrap-wayback-failed.json` were deleted, and stray
  `node-compile-cache/` / `tsx-501/` cache dirs were removed.
- `wrangler.jsonc` is left modified-but-uncommitted on purpose: the `MEDIA`
  `remote: true` line is a temporary import setting to revert after the
  import, and committing it would make the temporary state look intended.
- **A concurrent writer overwrote the finished script mid-session**:
  `scripts/unwrap-wayback.ts` was replaced at 08:19 by an older 704-line
  draft (4 type errors) while this session was running — no process of this
  session wrote it; most likely a stale editor buffer or one of the other
  open opencode sessions. The typecheck-clean version was restored from the
  session record (the overwritten draft was archived to the session temp
  dir as `unwrap-wayback.overwritten-0819.ts`). If this file regresses
  again, check for other agents/editors working in this repo.
- Dev-branch dry run: **the real WordPress import has not run**, so there is
  no imported content to dry-run against — the dev branch holds only the 16
  seed posts, and zero rows mention `web.archive.org`. The dry run was
  still executed (read-only) to prove the script works end-to-end against a
  live database: it reports `0 own-site wrapped URLs in 0 rows`, `KEPT: 0
  external Wayback citations`. The meaningful dry run happens after the
  import, per the RUNBOOK order (unwrap → post-import → verify).

**Verification this pass:** `pnpm typecheck` 0 errors (78 files), `pnpm test`
64/64 across 4 files (wayback suite included), `--help` and the dev-branch
dry run behave as documented, `migration/media-url-map.json` back to `{}`.

## Next

- Run the real import (RUNBOOK "Importing WordPress content"), then
  `unwrap-wayback --database=prod` (dry run, then `--apply` with the dev
  server up for media uploads), `post-import --apply` and
  `verify-migration --database=prod --base=<workers.dev url>` until it
  exits 0.
- Set the real secrets (`wrangler secret put`), push `dev`, let CI run,
  merge to `main` to deploy.
- Revert the temporary `MEDIA remote: true` line in `wrangler.jsonc` after
  the import (currently deliberately uncommitted).