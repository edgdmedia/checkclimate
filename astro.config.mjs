import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import { hyperdrive, kvCache, r2 } from "@emdash-cms/cloudflare";
import emdash from "emdash/astro";
import { defineConfig, sessionDrivers } from "astro/config";
import { fileURLToPath } from "node:url";
import { Features } from "lightningcss";
import { loadEnv } from "vite";

const mode = process.env.NODE_ENV === "production" ? "production" : "development";
const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };

const siteUrl = env.EMDASH_SITE_URL || "https://checkclimate.africa";

// `.env` sets a localhost URL for `astro dev`, and loadEnv reads it during
// `astro build` too. A build is always for a deployed Worker, so refuse to bake
// localhost into it: pass EMDASH_SITE_URL explicitly (see the deploy:* scripts).
if (process.argv.includes("build") && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(siteUrl)) {
	throw new Error(
		`EMDASH_SITE_URL is ${siteUrl} for a production build. Run \`pnpm deploy:preview\` or \`pnpm deploy:production\`, or set EMDASH_SITE_URL.`,
	);
}

/**
 * Native plugins that live in this repo, as plain data: the config must not
 * import a plugin's runtime, because that pulls EmDash into the config file.
 *
 * `source` is only used to build the Vite alias below — EmDash resolves plugin
 * entrypoints by module specifier, and these are not published packages.
 * Keep id and version in step with each plugin's `src/index.ts`.
 */
const localPluginSources = [
	{
		id: "checkclimate-site-settings",
		displayName: "Site settings",
		description:
			"Contact address, claim inbox, social profiles and the weather city. Editable in the admin.",
		version: "1.0.0",
		format: "native",
		entrypoint: "@checkclimate/plugin-site-settings",
		source: "./plugins/site-settings/src/index.ts",
	},
	{
		id: "resend-email",
		displayName: "Resend email",
		description: "Delivers EmDash's transactional mail (sign-in links, notices) via Resend.",
		version: "1.0.0",
		format: "native",
		entrypoint: "@checkclimate/plugin-resend-email",
		capabilities: ["hooks.email-transport:register"],
		source: "./plugins/resend-email/src/index.ts",
	},
	{
		id: "checkclimate-post-editor",
		displayName: "Post editor",
		description: "Post type picker and fact-check fields that only show on fact checks.",
		version: "1.0.0",
		format: "native",
		entrypoint: "@checkclimate/plugin-post-editor",
		adminEntry: "@checkclimate/plugin-post-editor/admin",
		source: "./plugins/post-editor/src/index.ts",
		adminSource: "./plugins/post-editor/src/admin.tsx",
	},
];

const localPlugins = localPluginSources.map(({ source, adminSource, ...descriptor }) => descriptor);

// Admin entries first: Vite matches aliases in order and a bare entrypoint
// key would otherwise also catch "<entrypoint>/admin".
const localPluginAliases = Object.fromEntries([
	...localPluginSources
		.filter((plugin) => plugin.adminEntry && plugin.adminSource)
		.map((plugin) => [plugin.adminEntry, fileURLToPath(new URL(plugin.adminSource, import.meta.url))]),
	...localPluginSources.map((plugin) => [
		plugin.entrypoint,
		fileURLToPath(new URL(plugin.source, import.meta.url)),
	]),
]);

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
		// Static pages, hardcoded in src/pages/ (StaticPage layout).
		"/about-us": cachedPage(["pages"]),
		"/contact-us": cachedPage(["pages"]),
		"/privacy-policy": cachedPage(["pages"]),
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
		// In-repo plugin entrypoints resolve by alias instead of a published
		// package. Same map as `localPlugins`, so they cannot drift apart.
		resolve: {
			alias: localPluginAliases,
		},
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
			plugins: localPlugins,
			siteUrl,
			toolbar: "client",
			// Our mark on the admin login page and sidebar instead of EmDash's.
			// The square mark (no text) reads in both admin themes and fits the
			// sidebar's small square slot.
			admin: {
				logo: "/brand/admin-mark.png",
				siteName: "Check Climate",
				favicon: "/favicon.ico",
			},
		}),
	],
	devToolbar: { enabled: false },
});