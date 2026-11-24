/**
 * The purge plugin's view of the environment.
 *
 * Kept in its own module, read at hook time (never at build time, never from
 * the database), so the plugin's logic stays a pure function of its arguments
 * and a test can replace this file. On the box the process environment comes
 * from `/etc/checkclimate.env` (systemd reads it); in `astro dev` from `.env`.
 */
const env = globalThis.process?.env ?? {};

export function purgeConfig() {
	return {
		zoneId: typeof env.CLOUDFLARE_ZONE_ID === "string" ? env.CLOUDFLARE_ZONE_ID.trim() : "",
		apiToken: typeof env.CLOUDFLARE_API_TOKEN === "string" ? env.CLOUDFLARE_API_TOKEN.trim() : "",
		enabled: env.CLOUDFLARE_PURGE_ENABLED !== "0",
	};
}
