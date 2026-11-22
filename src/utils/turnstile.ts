import { env } from "cloudflare:workers";

/**
 * Cloudflare Turnstile, server side.
 *
 * Enforcement follows EmDash's own comment rules: it only runs when a secret
 * key is configured (`TURNSTILE_SECRET_KEY` or `EMDASH_TURNSTILE_SECRET_KEY`).
 * Once configured it fails closed — a missing token, a rejected token and a
 * siteverify transport error all mean "do not save".
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The public site key for the widget, or "" when Turnstile is not configured. */
export function turnstileSiteKey(): string {
	return env.TURNSTILE_SITE_KEY ?? env.EMDASH_TURNSTILE_SITE_KEY ?? "";
}

export function turnstileSecretKey(): string {
	return env.TURNSTILE_SECRET_KEY ?? env.EMDASH_TURNSTILE_SECRET_KEY ?? "";
}

/** True when submissions will actually be checked. */
export function turnstileEnforced(): boolean {
	return turnstileSecretKey() !== "";
}

export interface TurnstileResult {
	ok: boolean;
	/** Why it failed, for logs and for the operator-facing error copy. */
	reason: "verified" | "not-configured" | "no-token" | "rejected" | "transport-error";
	codes: string[];
}

export async function verifyTurnstile(
	token: string | null | undefined,
	remoteIp?: string | null,
): Promise<TurnstileResult> {
	const secret = turnstileSecretKey();
	if (!secret) return { ok: true, reason: "not-configured", codes: [] };
	if (!token) return { ok: false, reason: "no-token", codes: ["missing-input-response"] };

	const body: Record<string, string> = { secret, response: token };
	if (remoteIp) body.remoteip = remoteIp;

	try {
		const response = await fetch(SITEVERIFY_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const data = (await response.json()) as {
			success?: boolean;
			"error-codes"?: string[];
		};
		return data.success === true
			? { ok: true, reason: "verified", codes: data["error-codes"] ?? [] }
			: { ok: false, reason: "rejected", codes: data["error-codes"] ?? [] };
	} catch (error) {
		console.error("[turnstile] siteverify request failed:", error);
		return { ok: false, reason: "transport-error", codes: [] };
	}
}
