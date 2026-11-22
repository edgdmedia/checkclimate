# Task: unwrap Wayback Machine URLs in imported content

Read `AGENTS.md`, `docs/PLAN.md` "Content migration", `scripts/post-import.ts` and `scripts/lib/migration-db.ts` first. Work on `dev`. Commit when done ("Unwrap Wayback Machine URLs after import"). Don't push or deploy.

## Background (measured on the live site, 2026-11-20)

The WordPress site was partly restored from the Wayback Machine. Many URLs in post content are wrapped as
`https://web.archive.org/web/<14-digit timestamp><flag>/<original URL>`, where `<flag>` is empty or one of `id_`, `im_`, `if_`, `js_`, `cs_`, and the original is sometimes written as `https:/host` with a single slash.

- 875 wrapped URLs in `src`/`href`/`srcset` across 66 posts.
- Images: 109 `src`/`srcset` occurrences, 68 unique originals, 67 of them on `checkclimate.africa/wp-content/uploads/…`.
- Links: about 766, to twitter.com, thecable.ng, climate.nasa.gov, instagram, facebook, youtube, bbc, ipcc and others. 10 are wrapped `web.archive.org` URLs and 9 are wrapped `archive.ph` URLs.
- Post meta `wayback_source_url` (87 posts): every value is a Wayback snapshot of the post's **own** permalink.

## Rule (from the site owner, revised)

**Only Wayback URLs whose original is on our own site (`checkclimate.africa` / `www.checkclimate.africa`) are processed.** Every other Wayback URL is an intentional archived citation (fact-check evidence). Leave it exactly as it is, including the one external wrapped image.

Our own wrapped URLs (re-measured):
- **Images: 109 occurrences, 67 unique originals** (`/wp-content/uploads/…`). Point the content at our media library copy in R2 (fetch it if the media step didn't bring it).
- **Links: 2** (both `/tag/…`). Strip the wrapper and rewrite to a root-relative internal path (`/tag/<slug>/`). Apply the same rule to any own-site post/page/category link: `/yyyy/mm/dd/slug/` and the rest stay as WordPress paths, which our routes keep.

## Build `scripts/unwrap-wayback.ts`

Use the same CLI as `post-import.ts`:
- Dry run by default; `--apply` to write.
- `--database=dev|prod` and `--slugs=`.
- One report line per URL: slug, kind, field, before → after, and action.
- Idempotent: a second run finds nothing to change.

Steps:

1. **Parse.** Write `unwrapWayback(url)`. It returns `{ original, timestamp, flag }` or `null`. Normalise `https:/` to `https://`, and unwrap repeatedly, because a wrapped URL can wrap another Wayback URL. If the original is itself `archive.ph`/`archive.today`, leave it as it is. That is a deliberate citation, not a wrapper. Unit-test this with vitest using the cases above.
2. **Walk** every post and page in Portable Text: `markDefs[].href`, image blocks (the asset/src fields the importer writes; check what it actually produces), embeds, and any leftover HTML blocks. Check the Portable Text shape in the building-emdash-site skill and in real imported rows. Don't guess.
3. **Links:** own-site only. Replace the href with the root-relative path of `original`. External Wayback hrefs are untouched, and the report lists them as `KEPT` with a count only, not one line each.
4. **Images.** Resolve the original in this order:
   a. If `migration/media-url-map.json` (the urlMap written by the importer's media step) has the original, or the same path on www/apex or `http`/`https`, use that R2 media item.
   b. Otherwise download the original from the live URL. If it isn't a 2xx response with an `image/*` content type, download it from the Wayback Machine using the `id_` flag (`https://web.archive.org/web/<ts>id_/<original>`) so you get the raw bytes, not the toolbar page.
   c. Upload it through EmDash's media API or CLI (check the emdash-cli skill and the media docs) so it gets a media row and an R2 object. Never write to R2 directly. Record the alt text from the content. Dedupe by original URL, so 67 originals give at most 67 uploads. Add each new mapping to `migration/media-url-map.json`.
   d. Rewrite the block to reference the media item the same way imported images do (`meta.storageKey`). Drop `srcset`.
   e. If both downloads fail, leave the URL as it is and report `FAILED`. Don't drop the image.
5. **`wayback_source_url` meta.** Stripping it gives the post's own permalink, which is redundant. Don't add it to the schema. In `post-import.ts`, check that the stripped value matches the entry's permalink and report any mismatch. Report only; don't import it.
6. **Throttle** Wayback requests to one per second, with a retry on 429/5xx. Download locally; nothing here runs on the Worker.
7. **Order.** Add this script to `docs/RUNBOOK.md` and `docs/PLAN.md` "Content migration". It runs after the media step and before `post-import.ts` and `verify-migration.ts`. Make `verify-migration.ts` fail if any Wayback URL whose original is on checkclimate.africa is left in content, unless it is in the FAILED list. External Wayback URLs are expected (about 764).

## Done

`pnpm typecheck` and `pnpm test` pass. Do a dry run against the dev branch. If it has no imported content yet, say so in `docs/STATUS.md` and skip the dry run. Update STATUS.md.
