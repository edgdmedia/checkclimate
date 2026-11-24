import node from "@astrojs/node";
import react from "@astrojs/react";
import emdash, { local, memoryCache, s3 } from "emdash/astro";
import { sqlite } from "emdash/db";
import { defineConfig, sessionDrivers } from "astro/config";
import { fileURLToPath } from "node:url";
import { Features } from "lightningcss";

/**
 * This site runs as one Node process on the owner's VPS, behind nginx and
 * Cloudflare. The database is a SQLite file on that box, media stays in the
 * R2 bucket it has always used, and the page cache is Cloudflare's edge.
 * The Workers deployment lives on `main` as the rollback.
 */

// The SQLite path is baked at BUILD time (EmDash reads it here, not at
// request time), so scripts/deploy-vps.sh sources /etc/checkclimate.build.env
// before `pnpm build` as well as systemd reading /etc/checkclimate.env to run
// it. Locally the default keeps dev inside the gitignored data/ directory.
const databasePath = process.env.DATABASE_PATH ?? "./data/emdash.db";
// Admin sessions must outlive a deploy, and a deploy replaces the checkout, so
// the store lives beside the database, not in .astro/.
const sessionDir = process.env.SESSION_DIR ?? "./.astro/sessions";

// Media: the S3 adapter (R2 over its S3 API) is chosen when S3_BUCKET is set.
// Without it (laptop, CI) the site falls back to local disk so `pnpm dev`
// needs no cloud credentials. EMDASH_STORAGE=s3|local forces either.
const storageDriver = process.env.EMDASH_STORAGE ?? (process.env.S3_BUCKET ? "s3" : "local");
const storage =
	storageDriver === "s3"
		? s3()
		: local({ directory: "./data/uploads", baseUrl: "/_emdash/api/media/file" });

const siteUrl = process.env.EMDASH_SITE_URL || "https://checkclimate.africa";

// `.env` keeps a localhost URL for `astro dev`, and Vite reads it during
// `astro build` too. A build is always for the box: refuse to bake localhost
// into it — pass EMDASH_SITE_URL explicitly (`pnpm deploy:production`).
if (process.argv.includes("build") && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(siteUrl)) {
	throw new Error(
		`EMDASH_SITE_URL is ${siteUrl} for a production build. Run \`pnpm deploy:production\`, or set EMDASH_SITE_URL.`,
	);
}

/**
 * Native plugins that live in this repo, as plain data: the config must not
 * import a plugin's runtime, because that pulls EmDash into the config file.
 *
 * `source` is only used to build the Vite alias below — EmDash resolves plugin
 * entrypoints by module specifier, and these are not published packages.
 * Keep id, entrypoint and capabilities in step with each plugin's own source.
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
	{
		id: "checkclimate-cloudflare-purge",
		displayName: "Cloudflare purge",
		description: "Purges the zone cache by Cache-Tag on publish, unpublish, delete, restore and live edit.",
		version: "1.0.0",
		format: "native",
		entrypoint: "@checkclimate/plugin-cloudflare-purge",
		capabilities: ["content:read", "users:read", "bylines:read"],
		source: "./plugins/cloudflare-purge/index.mjs",
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
 * No `cache:` provider and no `routeRules`, deliberately.
 *
 *   - With an Astro cache provider configured, EmDash stops using its own query
 *     cache: a home render goes from one database pass to ~14.
 *   - Astro strips `Cache-Tag` from a page its provider serves, and `Cache-Tag`
 *     is precisely how a publish purges the edge.
 *
 * Caching here is `Cache-Control` + `Cache-Tag` in src/middleware.ts, the zone
 * Cache Rule (docs/vps-runbook.md) and the purge plugin. The in-process query
 * cache below is what keeps the database quiet.
 */
export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
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
	session: {
		driver: sessionDrivers.fsLite({ base: sessionDir }),
	},
	vite: {
		// In-repo plugin entrypoints resolve by alias instead of a published
		// package. Same map as `localPlugins`, so they cannot drift apart.
		resolve: {
			alias: localPluginAliases,
		},
		css: {
			lightningcss: { exclude: Features.LightDark },
		},
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${databasePath}` }),
			storage,
			// One long-lived process, so this is a real cross-request cache:
			// `revalidate: 0` means "trust it until a write invalidates it", which
			// is exactly EmDash's own behaviour after content:afterSave, and the
			// edge purge happens at the same moment.
			objectCache: memoryCache({ defaultTtl: 3600, revalidate: 0, maxEntries: 5000 }),
			// Client IP for EmDash's auth rate limits and the comment endpoint.
			// Safe to trust these headers only because nginx answers 403 to
			// anything that did not come through Cloudflare.
			trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"],
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
