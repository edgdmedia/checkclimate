/**
 * Resend transport, as a plain function.
 *
 * Kept free of Cloudflare and EmDash imports so it can be unit tested with a
 * mocked fetch and reused by anything that needs to send mail (the claim desk
 * in `src/utils/email.ts` speaks the same API).
 */

export interface TransportMessage {
	to: string;
	cc?: string[];
	replyTo?: string;
	subject: string;
	/** Plain-text alternative. Required by Resend when html is present. */
	text: string;
	html?: string;
	/** Overrides the configured From: for this one message. */
	from?: string;
}

export interface TransportOptions {
	apiKey: string;
	/** Default From: header. */
	from: string;
	/** Injectable for tests; defaults to the global fetch. */
	fetch?: typeof fetch;
	/** Defaults to the Resend API. */
	url?: string;
}

export interface TransportResult {
	ok: boolean;
	/** Resend's id for the send, when it accepted the message. */
	id?: string;
	error?: string;
}

const RESEND_URL = "https://api.resend.com/emails";

function asRecipients(to: string): string[] {
	return to
		.split(",")
		.map((address) => address.trim())
		.filter(Boolean);
}

/**
 * Sends one message. Never throws: a transport that throws takes the request
 * down with it, and callers of the hook are background work.
 */
export async function sendWithResend(
	message: TransportMessage,
	options: TransportOptions,
): Promise<TransportResult> {
	const apiKey = options.apiKey.trim();
	if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set" };

	const from = (message.from ?? options.from).trim();
	if (!from) return { ok: false, error: "EMAIL_FROM is not set" };

	const to = asRecipients(message.to);
	if (to.length === 0) return { ok: false, error: "No recipient" };

	const body = {
		broadcast: false,
		from,
		to,
		...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
		...(message.replyTo ? { reply_to: message.replyTo } : {}),
		subject: message.subject,
		text: message.text,
		...(message.html ? { html: message.html } : {}),
	};

	const doFetch = options.fetch ?? fetch;
	try {
		const response = await doFetch(options.url ?? RESEND_URL, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});

		const payload = (await response.json().catch(() => null)) as
			| { id?: string; message?: string; name?: string }
			| null;

		if (!response.ok) {
			const reason = payload?.message ?? payload?.name ?? `HTTP ${response.status}`;
			return { ok: false, error: reason };
		}
		return { ok: true, ...(payload?.id ? { id: payload.id } : {}) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
