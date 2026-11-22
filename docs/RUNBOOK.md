# Check Climate Africa — runbook

This is the one-page answer to "what do I do when the site breaks, or I need
to change a secret, or I need to move a setting".

## Resources and bindings

| Resource | Cloudflare binding | What it holds |
|---|---|---|
| Worker | `checkclimate` (the Workers service) | The deployed site |
| Hyperdrive (primary) | `HYPERDRIVE` | Direct Neon connection, no query cache |
| Hyperdrive (cached) | `HYPERDRIVE_CACHED` | Same Neon connection, with the Hyperdrive read cache |
| R2 | `MEDIA` | Screenshots, uploads, media library |
| KV | `CACHE` | EmDash object cache (plugin settings, query results) |
| KV | `SESSION` | Admin sign-in sessions |
| Images | `IMAGES` | Cloudflare Images (not yet used) |
| Assets | `ASSETS` | Static files from `public/` and the built client |

The Worker is on the **Security Focus** Cloudflare account
(`9c8aaa232a52d145430685011e9fff9c`). Both Hyperdrive configs
(`checkclimate-db`, `checkclimate-db-cached`) point at the Neon **main**
(prod) branch. Local development never uses them: `scripts/with-env.mjs`
sets `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (and the
`_CACHED` variant) from `NEON_DEV_DATABASE_URL`, which Wrangler and the
Astro dev server honour in place of the remote config.

## Secrets

Worker secrets are set with `wrangler secret put`, not through the dashboard,
and they survive redeploys. After any Worker create or rename, run
`wrangler secret list` and compare with the list below.

| Secret | Purpose | How to rotate |
|---|---|---|
| `EMDASH_ENCRYPTION_KEY` | Encrypts plugin secrets (Resend key, Turnstile secret) at rest. **Losing it loses every encrypted setting.** | `npx emdash secrets generate` → `wrangler secret put EMDASH_ENCRYPTION_KEY`. Do this only when you are ready to re-enter every encrypted setting. |
| `RESEND_API_KEY` | Transactional email (sign-in links, comment notifications, claim desk emails). | Dashboard → API Keys. `wrangler secret put RESEND_API_KEY`. |
| `TURNSTILE_SECRET_KEY` | Server-side verification for the claim form and comments. | Dashboard → Turnstile → Site. `wrangler secret put TURNSTILE_SECRET_KEY`. |
| `TURNSTILE_SITE_KEY` | Public widget key. | Same as above, but set as a Worker var: `wrangler secret put TURNSTILE_SITE_KEY` or edit `wrangler.jsonc`'s `vars` and redeploy. |
| `CLAIMS_INBOX` | Operator override for where claim submissions are emailed. When unset, the desk address lives in the site settings plugin. | `wrangler secret put CLAIMS_INBOX`. |

The `EMDASH_SITE_URL` var is **not** a secret; it is in `wrangler.jsonc` and
used for canonical URLs, the sitemap and the RSS feed.

## Editing site settings

The desk can change the contact email, the claim inbox, the social profiles
and the weather city from the admin without a deploy:

1. Sign in at `/_emdash/admin` (passkey or magic link). `/admin/` is the
   branded door page that links there.
2. Open the **Plugins** page and find **Site settings**.
3. Edit the form and save. The change is visible on the next page load, at
   worst 60 seconds later (the Worker caches the settings for one minute per
   isolate, and pages are edge-cached for five minutes).

The operator can still pin the claim inbox above the form with the
`CLAIMS_INBOX` Worker var.

## Editing the content

Posts, pages, categories, tags, bylines, menus and comments all live in
Neon and are edited through the EmDash admin at `/_emdash/admin`. Publishing
a post invalidates the Workers Cache tag `posts`, so the next request pulls
the new copy.

## Importing WordPress content

Run the import from your laptop, never on the Worker (10 ms CPU), and **not
against Neon directly**: every import request makes hundreds of round trips to
Frankfurt (28–46 s each), and Neon Free suspends the compute after 5 idle
minutes, which kills the local Hyperdrive proxy's connections until dev is
restarted. Import into a local Postgres 18 (same major version as Neon), then
copy it to Neon in one dump. This is how the first import was done (2026-11-20).

1. **Local Postgres** (data lives in `data/pg`, gitignored):

   ```bash
   PG=/opt/homebrew/opt/postgresql@18/bin
   $PG/initdb -D data/pg -U postgres --auth=trust -E UTF8
   $PG/pg_ctl -D data/pg -o "-p 5433 -k /tmp" -l data/pg.log start
   $PG/psql -h localhost -p 5433 -U postgres -c "create database checkclimate"
   $PG/psql -h localhost -p 5433 -U postgres -c "alter user postgres password 'localimport'"  # Hyperdrive needs one
   ```

   Seed the schema only: `pnpm seed --url postgresql://postgres:localimport@localhost:5433/checkclimate --schema-only`.
   To start from what is in Neon instead, `pg_dump` Neon and strip Neon's
   column storage parameter before restoring:
   `pg_restore -f x.sql dump && grep -v "SET (pg_attver=" x.sql | psql <local>`.

2. **Media straight to R2:** temporarily add `"remote": true` to the `MEDIA`
   binding in `wrangler.jsonc` (revert afterwards; never commit it).

3. **Dev on port 4321** (passkeys are bound to `http://localhost:4321`; if the
   port is taken, dev moves to 4322 and passkey setup fails with "Invalid origin"):

   ```bash
   L=postgresql://postgres:localimport@localhost:5433/checkclimate
   CLOUDFLARE_ACCOUNT_ID=9c8aaa232a52d145430685011e9fff9c \
   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$L" \
   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED="$L" \
   pnpm exec astro dev
   ```

4. **Admin import** at `/_emdash/admin/import/wordpress` with the exporter
   migration key (`WP_MIGRATION_KEY` in `.env`). Map `post` → posts and `page`
   → pages, skip `elementor_library`, leave authors unmapped (guest bylines),
   menus off, logo off, SEO on. Then run the media step. Re-running is safe: the
   admin always sends `skipExisting` (matched by collection + slug + locale).
5. **Clean-up, all with `--database=local`:**
   - `pnpm tsx scripts/relink-media.ts --apply`: rebuilds
     `migration/media-url-map.json` from the exporter's attachment list and
     repoints image blocks the importer missed (byte-identical copies are stored
     once, so their blocks keep `wp-content` URLs).
   - `pnpm tsx scripts/unwrap-wayback.ts --apply` (needs `EMDASH_TOKEN` in `.env`,
     an API token from Settings → API Tokens; without it the CLI signs in as a
     "Dev Admin" that would be copied to prod).
   - `pnpm tsx scripts/post-import.ts --apply` (sets kickers).
   - Merge guest bylines into one per WordPress author, keeping the old
     `/author/<login>/` slugs (the importer names them after the login and adds
     `-2`, `-3`… per batch). Drop theme fields the importer created (`axil_*`,
     `select_banner_style`, `select_sidebar`, `wayback_source_url`). Delete the
     Home and Posts pages and WordPress's menus in the admin.
6. **Copy to Neon main** (back it up first):

   ```bash
   pg_dump "$NEON_DATABASE_URL" --no-owner --no-privileges -Fc -f data/neon-backup.dump
   pg_dump "$L" --no-owner --no-privileges -f data/local.sql
   { echo begin\;; echo "drop schema public cascade; create schema public;"; \
     grep -v "^SELECT pg_catalog.set_config('search_path'" data/local.sql | grep -v '^\\restrict\|^\\unrestrict'; \
     echo commit\;; } | psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -q
   ```

7. `pnpm tsx scripts/verify-migration.ts --database=prod` until it exits 0, then
   `--base=<workers.dev url>` after the deploy to check every old URL.

## Migration lock

If a deploy fails mid-migration, the migrations lock can be left in the
locked state and the next boot refuses to start. Fix it with:

```
psql $NEON_DATABASE_URL
UPDATE _emdash_migrations_lock SET is_locked = 0;
```

Then redeploy. The lock table is `_emdash_migrations_lock`; the migrations
themselves live in `_emdash_migrations`.

## Quotas and dashboards to watch

- **Workers free plan: 10 ms CPU per request.** The site is built to stay
  well under that; a page that starts taking 8+ ms should be profiled with
  `wrangler tail` and the Workers Profiling dashboard.
- **1102 errors** (CPU timeout) show up in the Workers logs. Any 1102 means
  a request crossed the budget; find it by the trace id and look at which
  query or loop ran.
- **Hyperdrive query count.** The cached binding is what public reads go
  through; the primary binding is what writes and admin reads go through.
  Sudden spikes in primary-binding queries usually mean the object cache
  (KV) is missing or the cache TTL was shortened.
- **Neon compute hours.** The Free plan includes a monthly compute-hours
  allowance (191.9 hours at the time of writing — check the Neon console's
  Usage page for the current number). The import scripts can burn a lot in
  one sitting; run them during the day, not overnight, so you can stop them.
- **KV writes.** Free plan is 1,000 writes/day. The object cache writes are
  mostly reads, and the session KV writes are admin-only, so the number
  should stay well under 100/day. If it climbs, a page is writing KV per
  request; find it by grepping `Astro.cache.set` and `kv.put` in the
  codebase.

## Rollback

A deploy is a new Worker version; Cloudflare keeps recent deployment
versions. To roll back:

1. `wrangler rollback` lists the recent versions and restores the one you
   pick. If the version you need is gone, redeploy the previous commit:
   `git checkout <commit> && pnpm astro build && pnpm wrangler deploy`.
2. The Workers Cache is independent of the Worker version, so the cache
   keeps serving the new routes; it does not need a purge.
3. The Neon database is the source of truth for content; a deploy never
   writes to it except through migrations. If a migration ran, it is
   already in the database and cannot be rolled back by redeploying.

## Backups

- **Neon:** automatic daily backups, 7-day retention.
- **R2 (MEDIA):** no automatic backup. The bucket is the only copy of
  uploaded screenshots; do not delete it. If you need a backup, use
  `rclone sync` to a second R2 bucket or to S3.
- **WordPress:** keep the old WordPress database and uploads for 30 days
  after the domain moves, then delete.
