import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import { hyperdrive, kvCache, r2 } from "@emdash-cms/cloudflare";
import emdash from "emdash/astro";
import { defineConfig, sessionDrivers } from "astro/config";
import { Features } from "lightningcss";
import { loadEnv } from "vite";

const mode = process.env.NODE_ENV === "production" ? "production" : "development";
const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };

const siteUrl = env.EMDASH_SITE_URL || "https://www.checkclimate.africa";

/**
 * Public routes only. Anything session-dependent (search, forms, `/admin`,
 * `/_emdash/*`) must never appear here. EmDash purges by tag on publish, so the
 * tags name the collections a page renders.
 */
const cachedPage = (tags) => ({
	maxAge: 300,
	swr: 86_400,
	tags: [...tags, "all"],
});

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	// WordPress URLs end in a slash, but EmDash's internal API routes are
	// registered without one and Astro refuses to redirect non-GET requests.
	// Serve both forms and let src/middleware.ts issue the canonical 301 for
	// public pages.
	trailingSlash: "ignore",
	site: siteUrl,
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	// Astro sessions live in a KV namespace so admin sign-in survives isolates.
	session: {
		driver: sessionDrivers.cloudflareKVBinding({ binding: "SESSION" }),
	},
	// Workers Cache in front of the Worker. Dev keeps caching disabled.
	cache: {
		provider: cacheCloudflare(),
	},
	routeRules: {
		// Home and the paginated story archives.
		"/": cachedPage(["posts", "pages"]),
		"/posts": cachedPage(["posts"]),
		"/posts/page/[n]": cachedPage(["posts"]),
		"/[yyyy]/[mm]/[dd]/[slug]": cachedPage(["posts"]),
		"/category/[slug]": cachedPage(["posts"]),
		"/category/[slug]/page/[n]": cachedPage(["posts"]),
		"/tag/[slug]": cachedPage(["posts"]),
		"/tag/[slug]/page/[n]": cachedPage(["posts"]),
		"/author/[slug]": cachedPage(["posts"]),
		"/author/[slug]/page/[n]": cachedPage(["posts"]),
		// Static pages: /about-us/, /contact-us/ and the generic page route.
		"/about-us": cachedPage(["pages"]),
		"/contact-us": cachedPage(["pages"]),
		"/privacy-policy-2": cachedPage(["pages"]),
		"/accessibility-statement": cachedPage(["pages"]),
		// Feeds and discovery files.
		"/feed": cachedPage(["posts"]),
		"/category/[slug]/feed": cachedPage(["posts"]),
		"/sitemap.xml": cachedPage(["posts", "pages"]),
		"/sitemap_index.xml": cachedPage(["posts", "pages"]),
		"/robots.txt": cachedPage(["posts", "pages"]),
		// Any other single-segment path is a CMS page.
		"/[slug]": cachedPage(["pages"]),
		// Not cached on purpose: /search (query dependent), /submit-a-claim and
		// every POST (the claim form), /admin, /_emdash/*, /404.
	},
	vite: {
		// `pg` (node-postgres) is CommonJS. The Workers build inlines it, but the
		// dev runner otherwise externalises node_modules and evaluates them with
		// `require`, which workerd does not provide. Pre-bundle it for SSR so dev
		// matches the build.
		optimizeDeps: {
			include: ["pg"],
		},
		ssr: {
			noExternal: true,
		},
		environments: {
			ssr: {
				resolve: {
					noExternal: true,
				},
			},
		},
		css: {
			lightningcss: { exclude: Features.LightDark },
		},
	},
	integrations: [
		react(),
		emdash({
			// Primary binding has query caching disabled (admin, writes,
			// migrations). The cached binding serves anonymous public reads.
			database: hyperdrive({
				binding: "HYPERDRIVE",
				cachedBinding: "HYPERDRIVE_CACHED",
				migrationConnectionStringEnv: "NEON_DATABASE_URL",
			}),
			storage: r2({ binding: "MEDIA" }),
			objectCache: kvCache({ binding: "CACHE", defaultTtl: 86_400 }),
			siteUrl,
			toolbar: "client",
		}),
	],
	devToolbar: { enabled: false },
});