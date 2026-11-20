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

Run the import from your laptop, never on the Worker:

1. Point the local dev server at the branch you want to import into. By
   default `scripts/with-env.mjs` maps `NEON_DEV_DATABASE_URL` onto both
   Hyperdrive bindings. To import into **prod** instead, override the env
   vars for that one run:

   ```bash
   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_DATABASE_URL" \
   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED="$NEON_DATABASE_URL" \
   pnpm exec astro dev
   ```

   (`wrangler.jsonc` itself does not need editing; the env vars take
   precedence over `localConnectionString`.)
2. Open `/_emdash/admin/import/wordpress` and run the import.
3. After the import, save the media `urlMap` to
   `migration/media-url-map.json` (the redirects middleware reads it).
4. `pnpm tsx scripts/unwrap-wayback.ts --database=prod` (dry run), review,
   then `--apply`. The old site was partly restored from the Wayback Machine,
   so content arrived with URLs wrapped as
   `https://web.archive.org/web/<timestamp><flag>/<original>`. The script
   unwraps only URLs whose original is on checkclimate.africa — links to
   root-relative WordPress paths, images to the media-library copy in R2
   (from the urlMap, or downloaded live / from Wayback and uploaded through
   the media API, which needs `pnpm dev` running). External Wayback URLs are
   deliberate archived citations and stay exactly as they are. It writes the
   URLs it could not fix to `migration/unwrap-wayback-failed.json`.
5. `pnpm tsx scripts/post-import.ts --database=prod` (dry run), review the
   report, then `--apply` to set kickers. Save the old `wayback_source_url`
   postmeta to `migration/wayback-source-urls.json` first if you want that
   check (it compares each stripped Wayback URL against the entry's own
   permalink; the meta is never imported).
6. `pnpm tsx scripts/verify-migration.ts --database=prod --base=https://checkclimate.<subdomain>.workers.dev`
   to check counts, every old URL, and that no own-site Wayback URL is left
   wrapped in content.
7. Stop the dev server; the next normal `pnpm dev` is back on the dev branch.

The import scripts (`scripts/post-import.ts`, `scripts/verify-migration.ts`)
connect to Neon directly with `pg`; they do not go through the Worker.

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
