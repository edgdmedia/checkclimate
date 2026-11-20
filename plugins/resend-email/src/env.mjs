/**
 * The only place this plugin touches the runtime environment.
 *
 * `cloudflare:workers` exists in the Worker and in `wrangler dev`; the vitest
 * suite aliases this module to a stub (see vitest.config.ts), which keeps the
 * transport itself a plain function of its arguments.
 */
import { env } from "cloudflare:workers";

/** Resend API key, or "" when mail is not configured. */
export function resendApiKey() {
	const key = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
	return key;
}

/** Default From: header, e.g. `Check Climate Africa <newsroom@checkclimate.africa>`. */
export function resendFrom() {
	const from = typeof env.EMAIL_FROM === "string" ? env.EMAIL_FROM.trim() : "";
	return from;
}
