/**
 * Legacy WordPress URL handling, bot hygiene and canonical URLs.
 *
 * This runs before routing, so nothing here touches the database:
 *   1. WordPress probe paths (/xmlrpc.php, /wp-includes/, plugin files, .env…)
 *      get a tiny static 404, cached for a day.
 *   2. Old admin, uploads, feed and sitemap URLs redirect as before.
 *   3. Unknown query parameters (utm_*, fbclid, cache-busters) are dropped
 *      with a cached 301, so random query strings cannot bypass the page
 *      cache; WordPress search (?s=) goes to /search/.
 *   4. Search is rate limited per visitor (SEARCH_LIMITER binding).
 *   5. Canonical trailing slash.
 */
import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro/middleware";
// Bundled at build time by the WordPress import (scripts/post-import.ts writes it).
import uploadMap from "../migration/media-url-map.json";

/** Old admin and login entries all land on the branded /admin/ page. */
const LEGACY_ADMIN = ["/wp-admin", "/wp-login.php", "/login"];

/** Dead menu endpoints from the old theme: gone for good, say so. */
const GONE_PREFIX = "/megamenu/";

const uploadRedirects = (uploadMap as Record<string, string>) ?? {};

function withQuery(target: string, url: URL): string {
	const query = url.search;
	return query && !target.includes("?") ? `${target}${query}` : target;
}

function moved(location: string, url: URL, status = 301): Response {
	return new Response(null, {
		status,
		headers: {
			location: withQuery(location, url),
			// Redirects are stable; let Cloudflare and browsers keep them.
			"cache-control": "public, max-age=86400",
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
			"cache-control": "public, max-age=86400",
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

/** Searches per visitor per minute before a 429 (see wrangler.jsonc). */
async function searchAllowed(request: Request): Promise<boolean> {
	const limiter = env.SEARCH_LIMITER;
	if (!limiter) {
		console.warn("search limiter: binding missing");
		return true;
	}
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	try {
		return (await limiter.limit({ key: `search:${ip}` })).success;
	} catch (error) {
		console.warn("search limiter failed", error);
		return true;
	}
}

/** Paths that must keep their exact shape: files and API endpoints. */
function needsSlash(pathname: string): boolean {
	if (pathname === "/") return false;
	if (pathname.endsWith("/")) return false;
	if (pathname.startsWith("/_emdash")) return false;
	if (pathname.startsWith("/api/")) return false;
	// The not-found page is a rewrite target: redirecting it would turn every
	// missing slug into a 301 → 404 chain.
	if (pathname === "/404") return false;
	// A dotted last segment is a file: /sitemap.xml, /robots.txt, /feed.xml.
	return !pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;
	const isGet = context.request.method === "GET" || context.request.method === "HEAD";


	// /wp-admin, /wp-admin/anything, /wp-login.php, /login → /admin/
	const isLegacyAdmin =
		pathname === "/wp-admin" ||
		pathname.startsWith("/wp-admin/") ||
		LEGACY_ADMIN.includes(pathname);
	if (isLegacyAdmin) return moved("/admin/", context.url);

	// 1. Scanners: answer without rendering or touching the database.
	if (PROBE.test(pathname)) return staticNotFound();

	if (pathname.startsWith(GONE_PREFIX)) {
		return new Response(GONE_BODY, {
			status: 410,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "public, max-age=86400",
				"x-robots-tag": "noindex",
			},
		});
	}

	// /wp-content/uploads/2024/05/file.jpg → the R2 object that replaced it.
	if (pathname.startsWith("/wp-content/uploads/")) {
		const target = uploadRedirects[pathname] ?? uploadRedirects[pathname.slice(1)];
		if (target) return moved(target, context.url);
		// Unmapped: the importer never saw this file. Old image hotlinks and
		// scanners land here; answer statically rather than render a page.
		return staticNotFound();
	}

	// The old RSS URL and the Yoast sitemap URLs people still have saved.
	if (pathname === "/feed" || pathname === "/feed.xml") {
		return moved("/feed/", context.url);
	}
	if (pathname === "/sitemap_index.xml" || /-sitemap\.xml$/.test(pathname)) {
		return moved("/sitemap.xml", context.url);
	}

	// 3. WordPress search links (/?s=term) → /search/?q=term.
	if (isGet && context.url.searchParams.has("s") && !ownsQuery(pathname)) {
		const term = context.url.searchParams.get("s") ?? "";
		return moved(`/search/?q=${encodeURIComponent(term)}`, new URL("/", context.url));
	}

	// 3. Drop parameters the site never reads, so every page has one cache key.
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

	// 4. Search runs a database query per new term: limit it per visitor.
	if (pathname.startsWith("/search") && context.url.searchParams.get("q") && !(await searchAllowed(context.request))) {
		return new Response("Too many searches. Please wait a minute and try again.", {
			status: 429,
			headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
		});
	}

	// 5. Canonical trailing slash, GET only: a redirect would drop a form POST.
	if (context.request.method === "GET" && needsSlash(pathname)) {
		return moved(`${pathname}/`, context.url);
	}

	return next();
});
