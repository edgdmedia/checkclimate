# Check Climate Africa — agent instructions

You are building the Astro + EmDash replacement for the WordPress site https://www.checkclimate.africa.
The full plan is `docs/PLAN.md`. Read it first. This file is the rules.

## Hard rules

- **Package manager: pnpm only.** Never npm or yarn. Pin `packageManager` in `package.json`.
- **Target: Cloudflare Workers (free plan) + Neon Postgres via Hyperdrive + R2 + KV.** Use `@astrojs/cloudflare`, `wrangler.jsonc`, and `hyperdrive()`, `r2()`, `kvCache()` from `@emdash-cms/cloudflare` exactly as `docs/PLAN.md` "Architecture" shows. **No D1, no SQLite, no `@astrojs/node`, no VPS files.**
- **10 ms CPU per request on the free plan.** Keep request work small: no heavy loops over all posts per request, no per-request image processing, paginate every list, and select only the fields a template needs. Long jobs (import, fix-up scripts) run locally, never on the Worker.
- **Media lives in R2** through the `MEDIA` binding.
- **Caching: Workers Cache** via `cacheCloudflare()` with a `routeRules` entry for every public route. Guard every hint: `if (Astro.cache?.enabled && hint) Astro.cache.set(hint)`. Never cache `/_emdash/*`, `/admin`, search, form POSTs or session-dependent responses. No root `/[...slug]` rule. `toolbar: "client"`.
- **KV free = 1,000 writes/day.** Long object-cache TTLs; never write KV per request.
- Always `pnpm astro build && pnpm wrangler deploy`, never deploy alone (deploy reads `dist/server/wrangler.json`). Don't run deploy yourself unless the task says so.
- **Keep WordPress URLs**: posts at `/[yyyy]/[mm]/[dd]/[slug]/`, `/category/[slug]/`, `/tag/[slug]/`, `/author/[slug]/`, `/feed/`.
- Never commit secrets. Ship `.env.example` with names only. `.env`, `*.db`, `data/`, `.astro/`, `dist/`, `node_modules/` are gitignored.
- Do not push to GitHub and do not deploy. Commit locally on branch `dev`, one commit per phase, with a clear message.
- Do not ship the `design/*.dc.html` files. They are mockups to read, not code to copy.

## Read these before coding

EmDash changes fast. Check current APIs before using them:

1. Skills (read the SKILL.md and the references they point to):
   - `~/.claude/skills/building-emdash-site/SKILL.md` (+ `references/*.md`) — schema, seed, queries, Portable Text, menus, taxonomies, images
   - `~/.claude/skills/wordpress-theme-to-emdash/SKILL.md` (+ `phases/*.md`, `references/concept-mapping.md`)
   - `~/.claude/skills/deploying-emdash-cloudflare/SKILL.md` and **`vps.md`** — the VPS setup and every known trap
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
pnpm build
pnpm preview       # wrangler dev against the built Worker
pnpm typecheck
pnpm test
```

If dev starts failing oddly after `pnpm add` or a config change: stop dev, `rm -rf node_modules/.vite`, start again.

## Definition of done for each phase

- `pnpm build` passes and `pnpm typecheck` is clean.
- The pages for that phase render in dev with seed data, in light and dark, at 1440px and 375px.
- No console errors. No `wp-content` URLs in templates.
- Commit on `dev`.
