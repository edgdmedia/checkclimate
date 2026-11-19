/**
 * Legacy WordPress URL handling and canonical slashes.
 *
 * This runs before routing, so old links keep working without a route file
 * for each pattern, and nothing here is cached: every rule is a redirect or a
 * 410, and Cloudflare caches 301s by itself for a long time.
 *
 * Order matters: the exact legacy paths first, then the uploads map, then the
 * canonical trailing slash for everything else.
 */
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

	// /wp-admin, /wp-admin/anything, /wp-login.php, /login → /admin/
	const isLegacyAdmin =
		pathname === "/wp-admin" ||
		pathname.startsWith("/wp-admin/") ||
		LEGACY_ADMIN.includes(pathname);
	if (isLegacyAdmin) return moved("/admin/", context.url);

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
		// Unmapped: the importer never saw this file. Show the branded 404
		// (it sets the status) instead of inventing a location.
		return context.rewrite("/404");
	}

	// The old RSS URL and the Yoast sitemap URLs people still have saved.
	if (pathname === "/feed" || pathname === "/feed.xml") {
		return moved("/feed/", context.url);
	}
	if (pathname === "/sitemap_index.xml" || /-sitemap\.xml$/.test(pathname)) {
		return moved("/sitemap.xml", context.url);
	}

	// Canonical trailing slash, GET only: a redirect would drop a form POST.
	if (context.request.method === "GET" && needsSlash(pathname)) {
		return moved(`${pathname}/`, context.url);
	}

	return next();
});
