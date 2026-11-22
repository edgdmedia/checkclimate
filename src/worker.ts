/**
 * Worker entry point.
 *
 * `handler` is the Astro (Cloudflare adapter) fetch handler. EmDash's
 * `createScheduledHandler()` runs scheduled publishing and maintenance from the
 * every-15-minutes Cron Trigger in wrangler.jsonc. `PluginBridge` is the entry
 * point sandboxed plugins use; exporting it is harmless when none are installed.
 *
 * `/api/weather` is answered here, before Astro: it needs the visitor's
 * location from `request.cf`, and it should not boot the CMS for a weather
 * reading.
 *
 * `emdash doctor` recognises this exact form.
 */
import handler, {
	createScheduledHandler,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";
import { forecastUrl, gridOf, placeOf, readingOf } from "./utils/weather";

export { PluginBridge };

const WEATHER_PATH = "/api/weather";

/** The bits of the Workers runtime used here (workers-types isn't global in this project). */
interface WaitUntil {
	waitUntil(promise: Promise<unknown>): void;
}
const WEATHER_TTL = 30 * 60;

function json(body: unknown, status: number, maxAge: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// Location-specific, so the browser may keep it but shared caches must not.
			"cache-control": `private, max-age=${maxAge}`,
		},
	});
}

async function weather(request: Request, ctx: WaitUntil): Promise<Response> {
	const url = new URL(request.url);
	const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
	const place = placeOf(cf, url.searchParams);
	if (!place) return json({ error: "no location" }, 404, 300);

	// One upstream request per ~11 km grid cell per half hour. The Cache API
	// works on custom domains; on workers.dev it is a no-op and every call
	// goes upstream, which is fine for preview traffic.
	const cache = (caches as unknown as { default: Cache }).default;
	const key = new Request(`https://weather.cache/${gridOf(place.latitude, place.longitude)}`);
	let upstream = await cache.match(key);
	if (!upstream) {
		try {
			const fresh = await fetch(forecastUrl(place.latitude, place.longitude), {
				signal: AbortSignal.timeout(6000),
			});
			if (!fresh.ok) return json({ error: "upstream" }, 502, 60);
			upstream = new Response(await fresh.text(), {
				headers: {
					"content-type": "application/json",
					"cache-control": `public, max-age=${WEATHER_TTL}`,
				},
			});
			ctx.waitUntil(cache.put(key, upstream.clone()));
		} catch {
			return json({ error: "upstream" }, 502, 60);
		}
	}

	const reading = readingOf(place, await upstream.json());
	if (!reading) return json({ error: "upstream" }, 502, 60);
	return json(reading, 200, WEATHER_TTL);
}

export default {
	...handler,
	fetch(request: Request, env: Env, ctx: WaitUntil) {
		if (new URL(request.url).pathname === WEATHER_PATH && request.method === "GET") {
			return weather(request, ctx);
		}
		return handler.fetch(request, env, ctx);
	},
	scheduled: createScheduledHandler(),
};
