/**
 * The only place this plugin touches the environment.
 *
 * On the box the process environment comes from `/etc/checkclimate.env`
 * (systemd reads it as an `EnvironmentFile`); in `astro dev` from `.env`, which
 * `scripts/with-env.mjs` copies into the process before Astro starts. It is
 * read at call time, never at build time, so a key rotation needs a restart and
 * not a rebuild.
 */
const value = (key) => {
	const raw = globalThis.process?.env?.[key];
	return typeof raw === "string" ? raw.trim() : "";
};

/** Resend API key, or "" when mail is not configured. */
export function resendApiKey() {
	return value("RESEND_API_KEY");
}

/** Default From: header, e.g. `Check Climate Africa <newsroom@checkclimate.africa>`. */
export function resendFrom() {
	return value("EMAIL_FROM");
}
