import { runtime } from "../runtime";

/**
 * Transactional email over Resend.
 *
 * Deliberately tiny: one function, the REST API, no SDK. The fetch to
 * api.resend.com is I/O, so it costs the request only wall-clock time.
 *
 * Sending is best effort for public forms: a claim must never be lost because
 * an email failed, so callers get a result object instead of a throw, and the
 * submission is already saved by then.
 */

const RESEND_URL = "https://api.resend.com/emails";

export interface EmailInput {
	to: string | string[];
	subject: string;
	/** Resend accepts HTML plus a plain-text alternative. */
	html: string;
	text: string;
	/** Defaults to EMAIL_FROM (or the address below when it is unset). */
	from?: string;
	replyTo?: string;
}

export interface EmailResult {
	ok: boolean;
	/** Resend's id, kept for logs. */
	id?: string;
	error?: string;
}

const FALLBACK_FROM = "Check Climate Africa <newsroom@checkclimate.africa>";

export function emailConfigured(): boolean {
	return Boolean(runtime.resendApiKey);
}

export function defaultFrom(): string {
	return runtime.emailFrom || FALLBACK_FROM;
}

/**
 * The address new claims are emailed to lives in the site settings plugin
 * (`siteConfig().claimsInbox`), not here: this module only knows how to send.
 */
function asArray(to: string | string[]): string[] {
	return Array.isArray(to) ? to : [to];
}

export async function sendEmail(input: EmailInput): Promise<EmailResult> {
	const apiKey = runtime.resendApiKey;
	if (!apiKey) {
		return { ok: false, error: "RESEND_API_KEY is not set" };
	}

	const body = {
		from: input.from ?? defaultFrom(),
		to: asArray(input.to),
		subject: input.subject,
		html: input.html,
		text: input.text,
		...(input.replyTo ? { reply_to: input.replyTo } : {}),
	};

	try {
		const response = await fetch(RESEND_URL, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const data = (await response.json().catch(() => ({}))) as {
			id?: string;
			name?: string;
			message?: string;
		};
		if (!response.ok) {
			console.error(
				"[email] Resend rejected the message:",
				response.status,
				data.name ?? "",
				data.message ?? "",
			);
			return {
				ok: false,
				error: data.message ?? `Resend responded ${response.status}`,
			};
		}
		return { ok: true, id: data.id };
	} catch (error) {
		console.error("[email] Resend request failed:", error);
		return { ok: false, error: "Resend request failed" };
	}
}
