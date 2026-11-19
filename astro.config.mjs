import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, sessionDrivers } from "astro/config";
import emdash, { local, memoryCache, s3 } from "emdash/astro";
import { sqlite } from "emdash/db";
import { Features } from "lightningcss";
import { loadEnv } from "vite";

const mode = process.env.NODE_ENV === "production" ? "production" : "development";
const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };

const siteUrl = env.EMDASH_SITE_URL || "http://localhost:4321";
const databasePath = env.DATABASE_PATH || "./data/checkclimate.db";
const sessionDir = env.SESSION_DIR || "./data/sessions";

const siteHost = (() => {
	try {
		return new URL(siteUrl).hostname;
	} catch {
		return "localhost";
	}
})();

const isLoopback = siteHost === "localhost" || siteHost === "127.0.0.1";

// `s3()` reads the S3_* variables from process.env at runtime. The bucket is
// the switch: with no bucket configured (local development), media falls back
// to the local filesystem.
const storage = env.S3_BUCKET
	? s3()
	: local({
			directory: "./data/uploads",
			baseUrl: "/_emdash/api/media/file",
		});

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	site: siteUrl,
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	security: isLoopback
		? undefined
		: {
				allowedDomains: [
					{ hostname: siteHost, protocol: "https" },
					{ hostname: siteHost, protocol: "http" },
				],
			},
	session: {
		driver: sessionDrivers.fsLite({ base: sessionDir }),
	},
	vite: {
		server: {
			allowedHosts: isLoopback ? [] : [siteHost],
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
			objectCache: memoryCache({ defaultTtl: 3600, revalidate: 0 }),
			siteUrl,
			trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"],
		}),
	],
	devToolbar: { enabled: false },
});