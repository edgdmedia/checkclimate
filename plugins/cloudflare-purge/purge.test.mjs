import { describe, expect, it, vi } from "vitest";
import { purgeTags } from "./index.mjs";

/** A ctx that records what the plugin logs. */
function logger() {
	return {
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
}

/** A fetch that answers each queued status in order and records the calls. */
function mockFetch(statuses) {
	const calls = [];
	const fetchImpl = vi.fn(async (url, init) => {
		calls.push({ url, init });
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
		const body = status === 200 ? { success: true } : { success: false, errors: [{ code: 10101 }] };
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	});
	return { fetchImpl, calls };
}

const config = { zoneId: "zone123", apiToken: "cf_token", enabled: true };
const settings = (fetchImpl) => ({ fetch: fetchImpl, retryDelaysMs: [0, 0, 0], config });

describe("purgeTags", () => {
	it("posts the tags to the zone endpoint with the token as a bearer", async () => {
		const { fetchImpl, calls } = mockFetch([200]);
		const ctx = logger();

		const result = await purgeTags(["posts", "all"], ctx, "publish", settings(fetchImpl));

		expect(result).toMatchObject({ attempted: true, ok: true, attempts: 1 });
		expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/zones/zone123/purge_cache");
		const headers = calls[0].init.headers;
		expect(headers.Authorization).toBe("Bearer cf_token");
		expect(JSON.parse(calls[0].init.body)).toEqual({ tags: ["posts", "all"] });
		expect(ctx.log.info).toHaveBeenCalledOnce();
	});

	it("retries a rate-limited purge and reports success on the second try", async () => {
		const { fetchImpl, calls } = mockFetch([429, 200]);
		const ctx = logger();

		const result = await purgeTags(["posts"], ctx, "publish", settings(fetchImpl));

		expect(result).toMatchObject({ ok: true, attempts: 2 });
		expect(calls).toHaveLength(2);
		expect(ctx.log.warn).toHaveBeenCalledWith(
			"[cloudflare-purge] rate limited, retrying",
			expect.objectContaining({ action: "publish" }),
		);
	});

	it("does not retry a forbidden purge: that is a token problem", async () => {
		const { fetchImpl, calls } = mockFetch([403]);
		const ctx = logger();

		const result = await purgeTags(["posts"], ctx, "publish", settings(fetchImpl));

		expect(result).toMatchObject({ ok: false, status: 403 });
		expect(calls).toHaveLength(1);
		expect(ctx.log.error).toHaveBeenCalledOnce();
	});

	it("gives up after the backoff ladder and says so", async () => {
		const { fetchImpl, calls } = mockFetch([429]);
		const ctx = logger();

		const result = await purgeTags(["posts"], ctx, "publish", settings(fetchImpl));

		expect(result).toMatchObject({ ok: false, reason: "rate-limited" });
		expect(calls).toHaveLength(4); // one try + three waits
		expect(ctx.log.error).toHaveBeenCalledWith(
			"[cloudflare-purge] purge gave up after retries",
			expect.objectContaining({ action: "publish" }),
		);
	});

	it("skips silently when the plugin is switched off", async () => {
		const { fetchImpl, calls } = mockFetch([200]);
		const ctx = logger();

		const result = await purgeTags(["posts"], ctx, "publish", {
			fetch: fetchImpl,
			config: { ...config, enabled: false },
		});

		expect(result).toMatchObject({ attempted: false, reason: "disabled" });
		expect(calls).toHaveLength(0);
	});

	it("sends nothing when there are no tags", async () => {
		const { fetchImpl, calls } = mockFetch([200]);
		const result = await purgeTags([undefined, ""], logger(), "publish", settings(fetchImpl));

		expect(result.reason).toBe("no-tags");
		expect(calls).toHaveLength(0);
	});
});
