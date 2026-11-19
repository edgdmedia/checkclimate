# Check Climate Africa: WordPress → Astro + EmDash

Status: plan, 2026-11-19. Owner: edgdmedia. Repo: github.com/edgdmedia/checkclimate.

## Goal

Replace the WordPress site at https://www.checkclimate.africa with an Astro + EmDash site that:

- follows the approved design (see `design/`),
- keeps every existing URL working (SEO),
- runs on the VPS (Node + SQLite) behind Cloudflare,
- stores all media in Cloudflare R2.

## What exists today (measured 2026-11-19)

| Item | Count / fact |
|---|---|
| Posts | 172 (Yoast `post-sitemap.xml`) |
| Pages | 6: `/`, `/posts/`, `/contact-us/`, `/accessibility-statement/`, `/about-us/`, `/privacy-policy-2/` |
| Categories | 36 (fixed nav uses 7: Agriculture, Aviation, Environment, Fact Check, Green Energy, News, Sustainability) |
| Tags | 277 |
| Images in posts | about 250, under `/wp-content/uploads/YYYY/MM/` |
| Permalinks | `/YYYY/MM/DD/<slug>/`, `/category/<slug>/`, `/tag/<slug>/` |
| Theme / builder | Blogar + Elementor; weather widget from the custom `edgd-weather` plugin |
| SEO | Yoast |
| Public REST API | `/wp-json/*` returns 403 (a security plugin blocks it) |
| Edge | Served straight from `nginx/1.24.0 (Ubuntu)`; **no `cf-ray` header, so it is not proxied by Cloudflare yet** |

## Design sources (in this repo)

| Path | What |
|---|---|
| `design/system/project/README.md` | Brand book: voice, colour rules, type, shape, logo rules |
| `design/system/project/tokens.json` | All tokens (light + dark). Source of truth for CSS variables |
| `design/system/project/components/*/README.md` + `bundle.css` | Component specs (cc- classes) |
| `design/pages/project/*.dc.html` | Page designs: Main (home), Article, FactCheck, Category (archive), About (+Contact), SubmitClaim, Header, Footer |
| `design/pages/project/canvas.json` | Notes on what changed vs the live site |
| `design/logos/*` | Logo files. In the page designs, `/_blob/6d94b35f…` = `check-climate-lockup.png`, `/_blob/6dab08b1…` = `check-climate-lockup-reverse.png`, `/_blob/33927b83…` = `check-climate-mark-simple.png` |

The `.dc.html` files are design mockups (a custom component format with `{{holes}}`, `<sc-for>`, `<dc-import>`). Read them for layout, spacing and copy; rebuild them as Astro components. Do not ship them.

## Architecture

```
Cloudflare (proxied DNS, Cache Rule, Cache-Tag purge, WAF)
  → nginx on the VPS (Cloudflare IPs only, Origin Certificate)
    → 127.0.0.1:4321  node ./dist/server/entry.mjs  (systemd, single process)
      → SQLite (WAL) at $DATABASE_PATH
      → media: R2 bucket `checkclimate-media` via S3 API (emdash `s3()`)
```

Key settings (details: `~/.claude/skills/deploying-emdash-cloudflare/vps.md`):

- `@astrojs/node` `mode: "standalone"`; no Cloudflare adapter.
- `sqlite({ url: \`file:${process.env.DATABASE_PATH}\` })` — the path is baked at build time.
- `storage: s3()` reading `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION=auto`; `local()` fallback when `S3_BUCKET` is unset (dev).
- `objectCache: memoryCache(...)`. **No Astro cache provider, no `routeRules`, no `Astro.cache.set`.**
- Sessions: `fsLite` in a dir outside the app (`SESSION_DIR`).
- `trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"]`.
- Middleware sets `Cache-Control` + `Cache-Tag` (public 200: `public, max-age=300, s-maxage=2592000`; 404: 60s; `/_emdash`, `/admin`, session cookie: `private, no-store`).
- Native plugin `plugins/cloudflare-purge/`: purge by tag on publish/unpublish/delete (debounced, retries 429).
- Native plugin `plugins/resend-email/`: email transport (magic links, invites, claim notifications).

## Content model

**Collection `posts`** (all news + fact checks, so URLs and archives stay unified)
- `title`, `slug`, `excerpt`, `content` (Portable Text), `featured_image` (media), `published_at`, bylines
- `kicker`: select `none | alert | fact_check` (set from the `ALERT:` / `FACT CHECK:` title prefix on import)
- `reading_time` (computed on render if not stored)
- Fact-check fields (shown only when `kicker = fact_check`): `claim` (text), `claim_source` (text, e.g. "Posted on X, July 2026"), `verdict` (select: False, Misleading, False context, Partly true, True, Unproven), `verdict_summary` (text), `verdict_note` (text), `sources` (Portable Text)
- `at_a_glance` (list of strings, optional — the Article "At a glance" box)
- SEO fields (title, description, og image) — filled by the Exporter's Yoast import when available

**Collection `pages`**: `title`, `slug`, `content`, `featured_image`, SEO fields.

**Collection `claims`** (private, never rendered publicly): `claim`, `platform`, `country`, `link`, `attachment` (media), `name`, `email`, `consent`, `status` (new / checking / published / rejected), `notes`.

**Taxonomies**: `category` (hierarchical, keep WP slugs), `tag` (keep WP slugs).

**Menus**: `primary` (the 7 categories), `footer` (About, Contact, Privacy, Accessibility, Submit a claim).

**Site settings** (singleton, native plugin `ctx.settings` merged over hardcoded defaults): contact email, social links (Facebook, X, YouTube, LinkedIn), weather default city.

## Routes (keep the WordPress URLs)

| Route | Template | Design |
|---|---|---|
| `/` | Home | Main.dc.html |
| `/[yyyy]/[mm]/[dd]/[slug]/` | Article or Fact-check (by `kicker`) | Article / FactCheck |
| `/category/[slug]/` (+ `/page/[n]/`) | Archive; Fact Check category gets topic filters | Category |
| `/tag/[slug]/` (+ `/page/[n]/`) | Archive | Category |
| `/author/[slug]/` | Byline archive | Category |
| `/posts/` | All posts archive | Category |
| `/about-us/`, `/contact-us/` | About + Contact | About |
| `/submit-a-claim/` | Claim form + thank-you state | SubmitClaim |
| `/privacy-policy-2/`, `/accessibility-statement/`, other pages | Generic page (`[slug].astro`) | Article prose styles |
| `/search/?q=` | Search results (EmDash search) | Category |
| `/feed/` | RSS (keep the path; feed readers use it) | — |
| `/sitemap.xml`, `/sitemap_index.xml` → sitemap | — | — |
| `/admin/` | Branded editor landing page → `/_emdash/admin` (noindex) | — |
| `/wp-admin*`, `/wp-login.php`, `/login` | 302 → `/admin/` | — |
| `/wp-content/uploads/*` | 301 to the new media URL (map generated from the import `urlMap`) | — |
| `/megamenu/*` | 410 | — |

## Features to rebuild

1. Header: top bar (date, weather, Light/Dark), logo lockup + strapline, search, "Submit a claim" button, category nav, mobile menu.
2. Weather widget: replaces `edgd-weather`. Client island using Open-Meteo (no key), browser geolocation with a default city (Lagos) from settings; cache 30 min in `localStorage`.
3. Light/Dark: `data-theme` on `<html>`, saved in `localStorage`, honours `prefers-color-scheme`, no flash (inline head script). Logo swaps by theme.
4. Home: hero + list, Top Stories tabs (working, with empty state), ALERT amber banner, Fact-check green band with claim card, News grid, category blocks.
5. Article: breadcrumb, share bar (Facebook, X, LinkedIn, WhatsApp, copy link), At a glance, pull quotes, tags, corrections mailto, comments, related stories.
6. Fact check: Claim / Verdict panel, sources box, share incl. WhatsApp, "More fact checks".
7. Archive: topic filter chips (links, not JS state: `?topic=` server-side), author/date/reading time, pagination.
8. Submit a claim: real form → `claims` collection, file upload to R2, Turnstile, email to the desk via Resend, thank-you state.
9. Comments: EmDash comments with moderation + Turnstile (import existing ones if the Exporter path is used).
10. Back-to-top button, accessible focus styles, 4.5:1 contrast (tokens README rules: small green text = `brand-forest`, never amber text on white).

## Phases

| # | Phase | Who | Output |
|---|---|---|---|
| 1 | Scaffold: Astro + EmDash, pnpm, Node adapter, SQLite, s3/local storage, tokens → CSS | opencode | builds and runs locally |
| 2 | Schema + seed (collections, taxonomies, menus, sample content from the designs) | opencode | `seed/seed.json`, admin works |
| 3 | Layout, components, all templates and routes above, light/dark, responsive | opencode | every page renders with seed data |
| 4 | Dynamic features: weather, claim form, comments, search, RSS, sitemap, redirects middleware, `/admin` page | opencode | features work locally |
| 5 | VPS bits: middleware cache headers, purge + Resend plugins, `deploy/` (systemd, nginx, env example), `scripts/deploy-vps.sh`, `scripts/backup.sh`, GitHub Actions | opencode | files ready, not deployed |
| 6 | Content import rehearsal locally (WXR or Exporter), post-import fix-up script | you + Claude | real content locally |
| 7 | Staging on `vps.checkclimate.africa` | you + Claude | full checklist passes |
| 8 | Cutover + 14-day rollback window | you + Claude | live |

## Content migration (posts, pages, images)

1. **Create the R2 bucket first** (`checkclimate-media`) and an R2 API token scoped to it. Set the `S3_*` env vars locally. EmDash's import copies media through the configured storage adapter, so images go straight into R2. Nothing is stored on the VPS disk.
2. **Pick an export path:**
   - **Preferred: EmDash Exporter plugin** on the WordPress site (connect with a WordPress application password). It also brings Yoast SEO titles and descriptions, featured images, menus, comments, logo and favicon. The REST API currently returns 403, so the security plugin must allow `/wp-json/` for authenticated requests (or allowlist our IP) during the migration.
   - **Fallback: WXR** from WordPress **Tools → Export → All content**. Brings posts, pages, terms, authors and attachment URLs. Doesn't bring SEO meta or comments; featured images come in as attachments.
3. **Import locally** at `/_emdash/admin/import/wordpress`: map `post → posts`, `page → pages`, authors → guest bylines (no logins needed), then run the **media step** (downloads from `/wp-content/uploads`, uploads to R2, rewrites URLs in content).
4. **Save the `urlMap`** returned by the media step to `migration/media-url-map.json`. It generates the `/wp-content/uploads/*` 301 map, so old image links and Google Images keep working.
5. **Run `scripts/post-import.ts`** (idempotent by slug, `--dry-run`, per-row report):
   - set `kicker` from the `FACT CHECK:` / `ALERT:` prefix,
   - check that every post has `published_at` matching its old `/YYYY/MM/DD/` path,
   - flag posts whose body still contains Elementor/shortcode markup or `wp-content` URLs,
   - list fact checks that still need `claim` / `verdict` filled in (editors do the recent ones by hand; older ones render without the verdict panel).
6. **Verify**: 172 posts, 6 pages, 36 categories, 277 tags, every sitemap URL returns 200 on the new site (script diffs old sitemap vs new), and no `wp-content` URLs left in content.
7. **Production**: copy the rehearsed SQLite file to the VPS (media is already in R2, so there's nothing else to move). At cutover, freeze WordPress publishing and re-run the import with `skipExisting` to pick up any posts written since the rehearsal.
8. Keep the WordPress install (DB + uploads) untouched and backed up for at least 30 days after cutover. **Never delete the R2 media bucket.**

## Cutover checklist

- Cloudflare: zone active, apex + www proxied, A record → VPS, Cache Rule (exclude `/_emdash`, `astro-session` cookie), www→apex (or apex→www, matching the current canonical `www`) redirect rule, Origin Certificate on nginx, nginx accepts only Cloudflare IPs.
- `EMDASH_SITE_URL=https://www.checkclimate.africa` in both build and runtime env; rebuild.
- Email: Resend domain verified (DKIM + `send.` subdomain records; leave the apex MX alone).
- Smoke test: every page type, images from R2, search, claim form + email, comment, magic link, passkey, `cf-cache-status: HIT` on the second request, purge MISS→HIT after a publish, a scheduled post goes live.
- Backups: nightly `sqlite3 .backup` → separate private R2 bucket `checkclimate-backups` (rclone, `no_head = true`), 30-day lifecycle.
- Google Search Console: submit the new sitemap, watch 404s for two weeks.

## Open questions for the owner

1. "The Cloudflare page is already set": does that mean the `checkclimate.africa` **zone** is on Cloudflare (DNS not proxied yet), or a Cloudflare **Pages** project? We are deploying to the VPS, so a Pages project won't be used.
2. Is the VPS the same box that hosts WordPress today, and does it run Virtualmin?
3. Can you install the EmDash Exporter plugin on WordPress, or should we use a WXR export?
4. Canonical host: keep `www.checkclimate.africa` (current) or move to the apex?
