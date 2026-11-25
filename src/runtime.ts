/**
 * Runtime configuration, read once from the process environment.
 *
 * On the box these come from `/etc/checkclimate.env` (systemd's
 * `EnvironmentFile`); in `astro dev` from `.env`, which `scripts/with-env.mjs`
 * copies into the process. Nothing here may hold a platform binding: this file
 * is the only place the app looks for environment values, so switching host is
 * a config change, not a hunt through templates.
 */
const str = (key: string, fallback = ""): string => {
	const value = process.env[key];
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const int = (key: string, fallback: number): number => {
	const value = Number(process.env[key]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const runtime = {
	/** The public origin this process was built for (canonical URLs, og tags). */
	siteUrl: str("EMDASH_SITE_URL", "https://checkclimate.africa"),

	/** Transactional mail (plugins/resend-email, src/utils/email.ts). */
	resendApiKey: str("RESEND_API_KEY"),
	emailFrom: str("EMAIL_FROM"),

	/** Operator override for where new claims are emailed. */
	claimsInbox: str("CLAIMS_INBOX"),

	/** Turnstile; empty means the forms do not check it (EmDash's own rule). */
	turnstileSiteKey: str("TURNSTILE_SITE_KEY", str("EMDASH_TURNSTILE_SITE_KEY")),
	turnstileSecretKey: str("TURNSTILE_SECRET_KEY", str("EMDASH_TURNSTILE_SECRET_KEY")),

	/** Zone cache purge (plugins/cloudflare-purge). */
	cloudflareZoneId: str("CLOUDFLARE_ZONE_ID"),
	cloudflareApiToken: str("CLOUDFLARE_API_TOKEN"),
	purgeEnabled: str("CLOUDFLARE_PURGE_ENABLED", "1") !== "0",

	/** Media objects written outside the library (claims, share cards). */
	s3Bucket: str("S3_BUCKET"),
	/**
	 * The media bucket's own domain (https://media.checkclimate.africa). When
	 * set, images are linked there and resized at Cloudflare's edge instead of
	 * by this process; unset (laptop, CI) keeps EmDash's media route.
	 */
	mediaPublicUrl: str("MEDIA_PUBLIC_URL").replace(/\/+$/, ""),

	/** HTTP listener. */
	port: int("PORT", 4331),
	host: str("HOST", "127.0.0.1"),
};

/** Absolute origin for building URLs when Astro's `site` is unavailable. */
export function origin(): string {
	try {
		return new URL(runtime.siteUrl).origin;
	} catch {
		return "https://checkclimate.africa";
	}
}
