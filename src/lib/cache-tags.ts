/**
 * The cache groups a public page belongs to.
 *
 * Cloudflare's zone cache stores a response under the groups named in its
 * `Cache-Tag` header. `plugins/cloudflare-purge` drops a group when content
 * changes, so the two must agree on the names — they are the same names EmDash
 * invalidates in its own query cache after a write: the collection, and the id
 * of the entry.
 *
 * The groups:
 *
 *  - "posts" / "pages" — the collection a page shows. Purging "posts" drops the
 *    home page, every archive, the feeds, the article and the pages that list
 *    stories in their rails: everything a new story could appear on, and
 *    nothing else. It is a wide stroke on purpose — a re-render on this box
 *    costs nothing, and one purge request per publish (Cloudflare's free plan
 *    allows five a minute) is the constraint worth respecting.
 *  - the chrome tags — settings and the two taxonomies. EmDash's own in-process
 *    cache invalidates on a write, but a taxonomy rename or a settings edit is
 *    not a content event, so the plugin never purges these. They are here so an
 *    operator can purge by tag by hand.
 *  - "all" — every public page. The emergency switch, and the tag a deploy
 *    workflow relies on when it purges everything. Nothing purges it by itself.
 *
 * Tags are per path, not per query: this deployment has no Astro cache
 * provider (see astro.config.mjs), so the middleware works the groups out from
 * the path it is serving.
 */

/** Settings, categories and tags. Manual-purge targets. */
export const CHROME_TAGS = ["emdash:settings", "emdash:taxonomy:category", "emdash:taxonomy:tag"];

/** Every public page. The emergency switch; never purged automatically. */
export const ALL_TAG = "all";

/** `/2025/04/18/flood-forecast-lagos/` — the WordPress permalink shape. */
const POST_PATH = /^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/;
/** `/posts/page/2/` and the per-taxonomy archives, with or without the page. */
const PAGED = /^\/(posts|category\/[^/]+|tag\/[^/]+|author\/[^/]+)(\/page\/\d+)?\/?$/;
const CATEGORY_FEED = /^\/category\/[^/]+\/feed\/?$/;

/**
 * The admin, its API, the forms and anything session-dependent. Never cached,
 * so they carry no tags: an untagged path means the middleware sends
 * `private, no-store`.
 */
const PRIVATE_PATH = /^\/(_emdash|_astro|_image|admin|login|search|submit-a-claim|api)(\/|$)/;

/** True for anything that must never reach the edge cache. */
export function isPrivatePath(pathname: string): boolean {
	return PRIVATE_PATH.test(pathname);
}

/** The collections a public path shows, or `[]` when it must not be cached. */
export function collectionsForPath(pathname: string): string[] {
	if (PRIVATE_PATH.test(pathname)) return [];
	// A path ending in a file extension is a file (/feed.xml, /sitemap.xml),
	// not a directory, so do not add a slash to it.
	const path =
		pathname.endsWith("/") || /\.[a-z0-9]{2,5}$/i.test(pathname) ? pathname : `${pathname}/`;

	if (path === "/") return ["posts", "pages"];
	if (path === "/feed/" || path === "/feed.xml" || path === "/rss.xml") return ["posts"];
	if (CATEGORY_FEED.test(path)) return ["posts"];
	if (/^\/sitemap[^/]*\.xml$/.test(path)) return ["posts", "pages"];
	if (path === "/robots.txt") return ["posts", "pages"];
	if (POST_PATH.test(path)) return ["posts"];
	if (PAGED.test(path)) return ["posts"];
	// A single-segment path is a page of the `pages` collection (/about-us/,
	// /privacy-policy/). Those templates list stories, so they carry both.
	if (/^\/[^/]+\/?$/.test(path)) return ["pages", "posts"];
	// /share/wide/<slug>.png and anything else: no tags, so no edge caching.
	// (Both renderers set their own long-lived Cache-Control, which the
	// middleware leaves alone when it is already present.)
	return [];
}

/** The full tag list for a public path: its collections, the chrome, and "all". */
export function tagsForPath(pathname: string): string[] {
	const collections = collectionsForPath(pathname);
	if (collections.length === 0) return [];
	return [...collections, ...CHROME_TAGS, ALL_TAG];
}
