# Check Climate Africa — agent instructions

You are building the Astro + EmDash replacement for the WordPress site https://www.checkclimate.africa.
The full plan is `docs/PLAN.md`. Read it first. This file is the rules.

## Hard rules

- **Package manager: pnpm only.** Never npm or yarn. Pin `packageManager` in `package.json`.
- **Target: the shared edgdmedia VPS (`169.58.2.239`, `server.edgdmedia.com`).** Astro + EmDash on Node 24 with `@astrojs/node` (`mode: "standalone"`), SQLite through `sqlite()` from `emdash/db`, media in R2 through `s3()`, one process under systemd behind nginx, Cloudflare as the edge cache. **No Workers adapter, no Hyperdrive, no Neon, no KV, no cron trigger** in the shipped config — the Workers build stays reachable on `main` as the rollback until the owner says the box is final.
- **Reads are free, so cache at the edge, not the CPU.** Paginate every list, select only the fields a template needs, and keep exactly one Node process (SQLite has a single writer and EmDash's scheduler runs in-process). Long jobs (content copy, fix-up scripts) run on the laptop.
- **Media lives in R2**, the same `checkclimate-media` bucket, reached over its S3 API (`S3_*` env). Never delete the bucket.
- **Caching: HTTP headers + a Cloudflare Cache Rule.** Middleware sets `Cache-Control` and `Cache-Tag` (`src/lib/cache-tags.ts`); `plugins/cloudflare-purge` purges by tag on publish. **Never configure an Astro `cache` provider or `routeRules` on this branch**: with a provider, EmDash skips its own query cache (14 queries per home render instead of 1) and Astro strips `Cache-Tag`. `toolbar: "client"`.
- **EmDash's in-process query cache is the database-saver:** `memoryCache({ defaultTtl: 3600, revalidate: 0 })`. Runtime config comes from `/etc/checkclimate.env` (systemd `EnvironmentFile`); build-time config (`EMDASH_SITE_URL`, `DATABASE_PATH`, `SESSION_DIR`, `S3_BUCKET`) from `/etc/checkclimate.build.env` — both, because the paths are baked at build.
- Deploys are `pnpm build:vps && wrangler-free`: the box pulls `main` and runs `scripts/deploy-vps.sh` (see `docs/vps-runbook.md`). Never deploy from this laptop unless the task says so, and never re-enable the Workers workflow without removing the box one.
- **Keep WordPress URLs**: posts at `/[yyyy]/[mm]/[dd]/[slug]/`, `/category/[slug]/`, `/tag/[slug]/`, `/author/[slug]/`, `/feed/`.
- Never commit secrets. Ship `.env.example` with names only. `.env`, `*.db`, `data/`, `.astro/`, `dist/`, `node_modules/` are gitignored.
- Do not push to GitHub and do not deploy. Commit locally, one commit per phase, with a clear message. The VPS migration is on branch `vps`; `dev`/`main` stay on the Workers build until the owner cuts over.
- Do not ship the `design/*.dc.html` files. They are mockups to read, not code to copy.

## Read these before coding

EmDash changes fast. Check current APIs before using them:

1. Skills (read the SKILL.md and the references they point to):
   - `~/.claude/skills/building-emdash-site/SKILL.md` (+ `references/*.md`) — schema, seed, queries, Portable Text, menus, taxonomies, images
   - `~/.claude/skills/wordpress-theme-to-emdash/SKILL.md` (+ `phases/*.md`, `references/concept-mapping.md`)
   - `~/.claude/skills/deploying-emdash-cloudflare/vps.md` — the Node + SQLite setup and every known trap (the SKILL.md's Workers sections no longer apply to this branch)
   - EmDash docs `/guides/site-transfer` (Postgres → SQLite copy), `/deployment/nodejs`, `/deployment/storage` — fetch via Context7 `/websites/emdashcms`
   - `~/.claude/skills/emdash-cli/SKILL.md` — CLI for seeds, types, export/import
   - `~/.claude/skills/creating-plugins/SKILL.md` — for the purge, Resend and settings plugins
2. Docs via the Context7 MCP: library `/websites/emdashcms` (and `/emdash-cms/emdash` for source). Also Astro docs via Context7. Prefer these over memory.
3. Design: `design/system/project/README.md`, `tokens.json`, `components/*/README.md`, `components/bundle.css`, then each `design/pages/project/*.dc.html`.

## Design implementation rules

- Generate CSS custom properties from `design/system/project/tokens.json` (light on `:root`, dark on `[data-theme="dark"]`). Keep token names.
- Font: Red Hat Display (400/500/700/900) — self-host via `@fontsource/red-hat-display` or Google Fonts with `display=swap`.
- Match the page designs' layout, spacing, copy structure and responsive breakpoints (900px, 600px). Every page must work at 360px with no horizontal scroll.
- Contrast rules from the README are mandatory: small green text uses `brand-forest`, amber is a fill only (black text on it), `leaf` only for fills/icons/24px+.
- Logos: copy `design/logos/*` into `src/assets/brand/`. Light mode `check-climate-lockup.png`, dark mode `check-climate-lockup-reverse.png`. Never redraw the logo.
- Images in content: use EmDash's `Image` component / a helper that resolves `meta.storageKey` first, then `src`. A media-library image has no `src`.
- Icons: inline stroke SVG components. No emoji, no icon fonts.
- Accessible markup: real `<button>`/`<a>`/`<label>`, `aria-label` on icon buttons, visible focus ring (amber outline), skip link.

## Commands

```bash
pnpm install
pnpm dev            # Astro 7 dev may run as a background daemon; logs in .astro/dev.log
pnpm build:vps      # standalone Node server in dist/server
pnpm start          # node ./dist/server/entry.mjs (what systemd runs on the box)
pnpm typecheck
pnpm test
```

If dev starts failing oddly after `pnpm add` or a config change: stop dev, `rm -rf node_modules/.vite`, start again.

## Definition of done for each phase

- `pnpm build:vps` passes and `pnpm typecheck` is clean.
- The pages for that phase render in dev with seed data, in light and dark, at 1440px and 375px.
- No console errors. No `wp-content` URLs in templates. No `cloudflare:workers` import.
- Commit on `vps`.
