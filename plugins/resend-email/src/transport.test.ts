import { describe, expect, it, vi } from "vitest";
import { sendWithResend, type TransportOptions } from "./transport";

/** A fetch that records calls and answers with what the case asks for. */
function mockFetch(
	response: { status: number; body?: unknown } | { throws: Error },
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		if ("throws" in response) throw response.throws;
		const status = response.status;
		const body = response.body ?? {};
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function options(fetchImpl: typeof fetch, extra?: Partial<TransportOptions>): TransportOptions {
	return { apiKey: "re_test_key", from: "Check Climate Africa <newsroom@checkclimate.africa>", fetch: fetchImpl, ...extra };
}

const message = {
	to: "reader@example.com",
	subject: "Your claim is with the desk",
	text: "Thanks — we read every submission.",
};

describe("sendWithResend", () => {
	it("posts the message to the Resend API with the key as a bearer token", async () => {
		const { fetchImpl, calls } = mockFetch({ status: 200, body: { id: "email_1" } });
		const result = await sendWithResend(message, options(fetchImpl));

		expect(result).toEqual({ ok: true, id: "email_1" });
		expect(calls[0]?.url).toBe("https://api.resend.com/emails");
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer re_test_key");
		expect(headers["content-type"]).toBe("application/json");

		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body).toMatchObject({
			from: "Check Climate Africa <newsroom@checkclimate.africa>",
			to: ["reader@example.com"],
			subject: "Your claim is with the desk",
			text: "Thanks — we read every submission.",
			broadcast: false,
		});
		// An absent html or cc must not appear as null/undefined in the payload.
		expect(body).not.toHaveProperty("html");
		expect(body).not.toHaveProperty("cc");
	});

	it("passes cc, replyTo, html and a per-message From", async () => {
		const { fetchImpl, calls } = mockFetch({ status: 200, body: { id: "email_2" } });
		await sendWithResend(
			{
				...message,
				cc: ["desk@example.org"],
				replyTo: "claims@example.org",
				html: "<p>Hello</p>",
				from: "Desk <desk@checkclimate.africa>",
			},
			options(fetchImpl),
		);

		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body).toMatchObject({
			from: "Desk <desk@checkclimate.africa>",
			cc: ["desk@example.org"],
			reply_to: "claims@example.org",
			html: "<p>Hello</p>",
		});
	});

	it("splits a comma-separated recipient list", async () => {
		const { fetchImpl, calls } = mockFetch({ status: 200, body: { id: "email_3" } });
		await sendWithResend({ ...message, to: "a@example.org, b@example.org" }, options(fetchImpl));
		expect(JSON.parse(String(calls[0]?.init.body)).to).toEqual(["a@example.org", "b@example.org"]);
	});

	it("reports a missing key without calling the API", async () => {
		const { fetchImpl, calls } = mockFetch({ status: 200, body: {} });
		const result = await sendWithResend(message, options(fetchImpl, { apiKey: "" }));
		expect(result).toEqual({ ok: false, error: "RESEND_API_KEY is not set" });
		expect(calls).toHaveLength(0);
	});

	it("reports a missing From without calling the API", async () => {
		const { fetchImpl, calls } = mockFetch({ status: 200, body: {} });
		const result = await sendWithResend(message, options(fetchImpl, { from: "" }));
		expect(result).toEqual({ ok: false, error: "EMAIL_FROM is not set" });
		expect(calls).toHaveLength(0);
	});

	it("refuses a message with no recipient", async () => {
		const { fetchImpl, calls } = mockFetch({ status: 200, body: {} });
		const result = await sendWithResend({ ...message, to: "  " }, options(fetchImpl));
		expect(result).toEqual({ ok: false, error: "No recipient" });
		expect(calls).toHaveLength(0);
	});

	it("turns an API rejection into an error message", async () => {
		const { fetchImpl } = mockFetch({
			status: 422,
			body: { name: "validation_error", message: "subject is invalid" },
		});
		const result = await sendWithResend(message, options(fetchImpl));
		expect(result).toEqual({ ok: false, error: "subject is invalid" });
	});

	it("falls back to the status when the error body is not useful", async () => {
		const { fetchImpl } = mockFetch({ status: 500 });
		const result = await sendWithResend(message, options(fetchImpl));
		expect(result).toEqual({ ok: false, error: "HTTP 500" });
	});

	it("never throws when the network fails", async () => {
		const { fetchImpl } = mockFetch({ throws: new Error("socket closed") });
		const result = await sendWithResend(message, options(fetchImpl));
		expect(result).toEqual({ ok: false, error: "socket closed" });
	});
});
