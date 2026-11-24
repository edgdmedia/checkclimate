/**
 * Legacy WordPress URL handling, bot hygiene, canonical URLs and the edge
 * cache policy.
 *
 * This runs before routing, so nothing here touches the database:
 *   1. www redirects to the bare domain, before anything is served or cached.
 *   2. WordPress probe paths (/xmlrpc.php, /wp-includes/, plugin files, .env…)
 *      get a tiny static 404, cached for a day.
 *   3. Old admin, uploads, feed and sitemap URLs redirect as before.
 *   4. Unknown query parameters (utm_*, fbclid, cache-busters) are dropped
 *      with a cached 301, so random query strings cannot bypass the page
 *      cache; WordPress search (?s=) goes to /search/.
 *   5. Search is rate limited per visitor (src/lib/kv-lite.ts).
 *   6. Canonical trailing slash.
 *   7. Every response that leaves here carries the Cache-Control (and
 *      Cache-Tag) the Cloudflare edge needs — see the block at the bottom.
 */
import { defineMiddleware } from "astro/middleware";
import { allow } from "./lib/kv-lite";
import { isPrivatePath, tagsForPath } from "./lib/cache-tags";

/** Where EmDash serves library files out of the bucket. Cached for a year. */
const MEDIA_PATH = "/_emdash/api/media/file/";

/**
 * Old WordPress upload path → R2 object, bundled at build time by
 * scripts/post-import.ts. Imported lazily: the 154 KB of JSON would
 * otherwise be parsed into the middleware chunk on every cold start, even
 * though only /wp-content/uploads/* requests ever look at it.
 */
let uploadRedirects: Promise<Record<string, string>> | undefined;
function uploadsMap(): Promise<Record<string, string>> {
	return (uploadRedirects ??= import("../migration/media-url-map.json").then(
		(m) => (m.default ?? {}) as Record<string, string>,
	));
}

/** Old admin and login entries all land on the branded /admin/ page. */
const LEGACY_ADMIN = ["/wp-admin", "/wp-login.php", "/login"];

/** Dead menu endpoints from the old theme: gone for good, say so. */
const GONE_PREFIX = "/megamenu/";

/** Searches per visitor per minute before a 429 (was a Workers rate limit). */
const SEARCH_LIMIT = 20;

function withQuery(target: string, url: URL): string {
	const query = url.search;
	return query && !target.includes("?") ? `${target}${query}` : target;
}

function moved(location: string, url: URL, status = 301): Response {
	return new Response(null, {
		status,
		headers: {
			location: withQuery(location, url),
			// Redirects are stable; keep them at the edge for a month. A
			// stale entry costs one render, not correctness.
			"cache-control": "public, max-age=2592000",
		},
	});
}

const GONE_BODY = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Gone — Check Climate Africa</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="/"></head>
<body style="font:16px/1.6 system-ui,sans-serif;margin:0;padding:48px 24px;color:#12261B">
<main style="max-width:640px;margin:0 auto">
<h1 style="font-size:28px;margin:0 0 12px">That page no longer exists</h1>
<p style="margin:0 0 24px">This was a menu endpoint of the old WordPress site. It has no replacement.</p>
<p style="margin:0"><a href="/" style="color:#1E4B33;font-weight:700">Go to Check Climate Africa</a></p>
</main></body></html>`;

/**
 * What WordPress scanners ask for. None of it exists here; answer without
 * rendering a page. (/wp-admin and /wp-login.php redirect to /admin/;
 * /wp-content/uploads/ has its own map.)
 */
const PROBE =
	/^\/(?:wp-includes|wp-json|wp-content\/(?!uploads\/)|cgi-bin|vendor|phpmyadmin|\.git|\.env|\.well-known\/(?!security\.txt))|\.(?:php\d?|asp|aspx|jsp|cgi|env|ini|sql|bak|old|log|yml|yaml)$/i;

const NOT_FOUND_BODY = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Not found — Check Climate Africa</title><meta name="robots" content="noindex"></head>
<body style="font:16px/1.6 system-ui,sans-serif;margin:0;padding:48px 24px;color:#12261B">
<main style="max-width:640px;margin:0 auto"><h1 style="font-size:28px;margin:0 0 12px">Page not found</h1>
<p style="margin:0"><a href="/" style="color:#1E4B33;font-weight:700">Go to Check Climate Africa</a></p>
</main></body></html>`;

function staticNotFound(): Response {
	return new Response(NOT_FOUND_BODY, {
		status: 404,
		headers: {
			"content-type": "text/html; charset=utf-8",
			// Scanner paths rotate, but any given one repeats across the
			// internet for months; a day was too short a memory.
			"cache-control": "public, max-age=2592000",
			"x-robots-tag": "noindex",
		},
	});
}

/** Query parameters the site reads; anything else on a page is dropped. */
const KEPT_PARAMS = new Set(["_preview", "locale", "topic", "q", "download"]);

/** Routes whose query strings are left alone (APIs, admin, files). */
function ownsQuery(pathname: string): boolean {
	return (
		pathname.startsWith("/_emdash") ||
		pathname.startsWith("/api/") ||
		pathname.startsWith("/admin") ||
		pathname.startsWith("/share/") ||
		pathname.startsWith("/_astro/") ||
		pathname.startsWith("/_image")
	);
}

/**
 * The limiter keeps a list of timestamps per IP in this process (see
 * src/lib/kv-lite.ts). It fails open, exactly as the Workers binding did: a
 * limiter that cannot decide must not lock a reader out of search.
 */
function searchAllowed(request: Request): boolean {
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	return allow(`search:${ip}`, SEARCH_LIMIT);
}

/** Paths that must keep their exact shape: files and API endpoints. */
function needsSlash(pathname: string): boolean {
	if (pathname === "/") return false;
	if (pathname.endsWith("/")) return false;
	if (pathname.startsWith("/_emdash")) return false;
	if (pathname.startsWith("/api/")) return false;
	// Astro's own endpoints key their work off the exact path and the query
	// string: a slash redirect costs a second origin request per image and
	// lands the transform on the wrong (non-cached) handler.
	if (pathname === "/_image" || pathname.startsWith("/_astro/")) return false;
	if (pathname.startsWith("/cdn-cgi/")) return false;
	// The not-found page is a rewrite target: redirecting it would turn every
	// missing slug into a 301 → 404 chain.
	if (pathname === "/404") return false;
	// A dotted last segment is a file: /sitemap.xml, /robots.txt, /feed.xml.
	return !pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

/** The bare domain, and the hosts that may serve it without redirecting. */
const CANONICAL_HOST = "checkclimate.africa";
function isOwnHost(host: string): boolean {
	return (
		host === CANONICAL_HOST ||
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "127.0.0.1" ||
		// The staging name the VPS runbook uses before cutover.
		host.startsWith("vps.") ||
		host.startsWith("checkclimate.") // workers.dev preview: checkclimate.<subdomain>.workers.dev
	);
}

/**
 * Copy a response with extra headers.
 *
 * Building a new Response is deliberate: depending on the adapter, the object
 * handed back from `next()` may have immutable headers, and a thrown TypeError
 * deep in middleware takes the page down.
 */
function withHeaders(response: Response, patch: Record<string, string>): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(patch)) headers.set(name, value);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;
	const isGet = context.request.method === "GET" || context.request.method === "HEAD";

	// 1. www → bare domain, before anything is served or cached. The edge keys
	// on the path, so a redirect produced after routing could be stored under
	// the bare domain and then served there — a loop. (A zone Redirect Rule can
	// do this instead; the runbook keeps it in one place, here.)
	const host = context.request.headers.get("host")?.replace(/:\d+$/, "");
	if (host && host !== CANONICAL_HOST && !isOwnHost(host)) {
		const target = new URL(context.request.url);
		target.hostname = CANONICAL_HOST;
		target.protocol = "https:";
		// The canonical site is always on 443. On the box the process listens on
		// 4331, and depending on how the URL was built that port can be part of
		// it; keeping it would aim the visitor at a closed port.
		target.port = "";
		// moved() re-attaches the query from the request; strip it here so a
		// parameter cannot be doubled into something like ?a=1?a=1.
		target.search = "";
		return moved(target.toString(), context.url);
	}

	// /wp-admin, /wp-admin/anything, /wp-login.php, /login → /admin/
	const isLegacyAdmin =
		pathname === "/wp-admin" ||
		pathname.startsWith("/wp-admin/") ||
		LEGACY_ADMIN.includes(pathname);
	if (isLegacyAdmin) return moved("/admin/", context.url);

	// 2. Scanners: answer without rendering or touching the database.
	if (PROBE.test(pathname)) return staticNotFound();

	if (pathname.startsWith(GONE_PREFIX)) {
		return new Response(GONE_BODY, {
			status: 410,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "public, max-age=2592000",
				"x-robots-tag": "noindex",
			},
		});
	}

	// /wp-content/uploads/2024/05/file.jpg → the R2 object that replaced it.
	if (pathname.startsWith("/wp-content/uploads/")) {
		const map = await uploadsMap();
		const target = map[pathname] ?? map[pathname.slice(1)];
		if (target) return moved(target, context.url);
		// Unmapped: the importer never saw this file. Old image hotlinks and
		// scanners land here; answer statically rather than render a page.
		return staticNotFound();
	}

	// The old RSS URL and the Yoast sitemap URLs people still have saved.
	if (pathname === "/feed" || pathname === "/feed.xml") {
		return moved("/feed/", context.url);
	}
	// The WordPress privacy page slug was privacy-policy-2.
	if (pathname === "/privacy-policy-2" || pathname === "/privacy-policy-2/") {
		return moved("/privacy-policy/", context.url);
	}
	if (pathname === "/sitemap_index.xml" || /-sitemap\.xml$/.test(pathname)) {
		return moved("/sitemap.xml", context.url);
	}

	// 4. WordPress search links (/?s=term) → /search/?q=term.
	if (isGet && context.url.searchParams.has("s") && !ownsQuery(pathname)) {
		const term = context.url.searchParams.get("s") ?? "";
		return moved(`/search/?q=${encodeURIComponent(term)}`, new URL("/", context.url));
	}

	// 4. Drop parameters the site never reads, so every page has one cache key.
	if (isGet && context.url.search && !ownsQuery(pathname)) {
		const kept = new URLSearchParams();
		for (const [key, value] of context.url.searchParams) {
			if (KEPT_PARAMS.has(key)) kept.append(key, value);
		}
		const query = kept.toString();
		if (query !== context.url.search.slice(1)) {
			const clean = `${needsSlash(pathname) ? `${pathname}/` : pathname}${query ? `?${query}` : ""}`;
			return moved(clean, new URL("/", context.url));
		}
	}

	// 5. Search runs a database query per new term: limit it per visitor.
	if (pathname.startsWith("/search") && context.url.searchParams.get("q") && !searchAllowed(context.request)) {
		return new Response("Too many searches. Please wait a minute and try again.", {
			status: 429,
			headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
		});
	}

	// 6. Canonical trailing slash, GET only: a redirect would drop a form POST.
	if (context.request.method === "GET" && needsSlash(pathname)) {
		return moved(`${pathname}/`, context.url);
	}

	let response = await next();

	// EmDash writes sitemap <loc>s without the trailing slash (it adds one only
	// under Astro's trailingSlash: "always", which would also hit its API
	// routes). Page URLs here always end in "/", so add it to listed pages —
	// not to images or other files.
	if (/^\/sitemap-[a-z0-9_-]+\.xml$/.test(pathname) && response.status === 200) {
		const xml = await response.text();
		const fixed = xml.replace(/<loc>([^<]*?)<\/loc>/g, (whole, loc: string) => {
			const last = loc.slice(loc.lastIndexOf("/") + 1);
			return loc.endsWith("/") || last.includes(".") ? whole : `<loc>${loc}/</loc>`;
		});
		response = new Response(fixed, { status: response.status, headers: response.headers });
	}

	// 7. The edge cache policy. This deployment has no Astro cache provider
	// (see astro.config.mjs), so these headers are the whole scheme: the zone
	// Cache Rule makes HTML eligible, Cloudflare honours `s-maxage` for how
	// long, and `Cache-Tag` is what a publish purges. `stale-while-revalidate`
	// is not used — Cloudflare ignores it when `s-maxage` is present.
	//
	// Anything that already set its own Cache-Control (the API routes, the
	// share cards, the static 404/410 above) is left alone.
	if (isGet && !response.headers.has("cache-control")) {
		const session = context.request.headers.get("cookie")?.includes("astro-session=");
		let patch: Record<string, string>;
		if (response.status === 200 && pathname.startsWith(MEDIA_PATH)) {
			// Media is served out of R2 through EmDash's route. A key is either
			// content-addressed or replaced by a re-upload under the same name,
			// and the library URL carries the filename, so a year is safe — and
			// it is the Cloudflare maximum.
			patch = { "cache-control": "public, max-age=31536000, immutable" };
		} else if (response.status !== 200) {
			patch =
				response.status === 404 && !session && !isPrivatePath(pathname)
					// A typo'd slug should not be remembered for a month: a page
					// that has not been written yet must appear as soon as the
					// desk publishes it.
					? { "cache-control": "public, max-age=60, s-maxage=60" }
					: { "cache-control": "private, no-store" };
		} else {
			const tags = session ? [] : tagsForPath(pathname);
			patch =
				tags.length === 0
					? { "cache-control": "private, no-store" }
					: { "cache-control": "public, max-age=300, s-maxage=2592000", "cache-tag": tags.join(",") };
		}
		response = withHeaders(response, patch);
	}

	return response;
});
