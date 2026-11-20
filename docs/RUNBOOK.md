# Check Climate Africa — runbook

This is the one-page answer to "what do I do when the site breaks, or I need
to change a secret, or I need to move a setting".

## Resources and bindings

| Resource | Cloudflare binding | What it holds |
|---|---|---|
| Worker | `checkclimate-africa` (the Workers service) | The deployed site |
| Hyperdrive (primary) | `HYPERDRIVE` | Direct Neon connection, no query cache |
| Hyperdrive (cached) | `HYPERDRIVE_CACHED` | Same Neon connection, with the Hyperdrive read cache |
| R2 | `MEDIA` | Screenshots, uploads, media library |
| KV | `CACHE` | EmDash object cache (plugin settings, query results) |
| KV | `SESSION` | Admin sign-in sessions |
| Images | `IMAGES` | Cloudflare Images (not yet used) |
| Assets | `ASSETS` | Static files from `public/` and the built client |

The Worker is on the **Security Focus** Cloudflare account
(`3a1a378bdf2b8bc66490838fe500dce4`). The two Hyperdrive bindings are
configured in the Cloudflare dashboard and point at the Neon dev branch by
default; the prod branch is wired in only for the import and the migration
scripts.

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

1. Sign in at `/admin/` (passkey or magic link).
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

1. In `wrangler.jsonc`, temporarily set the Hyperdrive
   `localConnectionString` to the **prod** Neon connection string.
2. `pnpm dev` and open `/_emdash/admin/import/wordpress`.
3. After the import, save the media `urlMap` to
   `migration/media-url-map.json`.
4. `pnpm tsx scripts/post-import.ts` (dry run) then `--apply` to set kickers.
5. `pnpm tsx scripts/verify-migration.ts --database=prod --base=https://<preview>.workers.dev`
   to check counts and URLs.
6. Switch `localConnectionString` back to the dev branch.

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
- **Neon CU-hours.** Free plan is 10 CU-hours/month. The import scripts can
  burn a lot in one sitting; run them during the day, not overnight, so you
  can stop them.
- **KV writes.** Free plan is 1,000 writes/day. The object cache writes are
  mostly reads, and the session KV writes are admin-only, so the number
  should stay well under 100/day. If it climbs, a page is writing KV per
  request; find it by grepping `Astro.cache.set` and `kv.put` in the
  codebase.

## Rollback

A deploy is a new Worker version; Cloudflare keeps the previous one for a
few minutes. To roll back:

1. `wrangler rollback` (or, if the rollback window has passed, redeploy the
   previous commit: `git checkout <commit> && pnpm astro build && pnpm wrangler deploy`).
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
