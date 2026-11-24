/**
 * GET /api/weather?city=&country=&lat=&lon=
 *
 * The reading in the top bar (src/components/WeatherCard.astro), replacing the
 * WordPress EDGD Weather plugin. One upstream call per ~11 km grid cell per
 * half hour: the body is kept in this process's TTL map (src/lib/kv-lite.ts),
 * so Open-Meteo sees a handful of requests a day whatever the traffic.
 *
 * There is no server-side geolocation on this host. The page passes the
 * site-settings place, and the card may replace the coordinates with the
 * browser's own geolocation when the visitor has already granted it. The
 * answer is per place, so it is `private`: a shared cache must not mix cities.
 */
import type { APIRoute } from "astro";
import { cacheGet, cacheSet } from "../../lib/kv-lite";
import { forecastUrl, gridOf, placeOf, readingOf } from "../../utils/weather";

const TTL_SECONDS = 30 * 60;

function json(body: unknown, status: number, maxAge: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": `private, max-age=${maxAge}`,
		},
	});
}

export const GET: APIRoute = ({ url }) => {
	const place = placeOf(url.searchParams);
	if (!place) return json({ error: "no location" }, 404, 300);

	const key = `weather:${gridOf(place.latitude, place.longitude)}`;
	const cached = cacheGet(key);
	if (cached) {
		const reading = readingOf(place, JSON.parse(cached));
		return reading ? json(reading, 200, TTL_SECONDS) : json({ error: "upstream" }, 502, 60);
	}

	return fetchUpstream(place, key);
};

async function fetchUpstream(place: NonNullable<ReturnType<typeof placeOf>>, key: string): Promise<Response> {
	let body: unknown;
	try {
		const upstream = await fetch(forecastUrl(place.latitude, place.longitude), {
			signal: AbortSignal.timeout(6000),
		});
		if (!upstream.ok) return json({ error: "upstream" }, 502, 60);
		body = await upstream.json();
	} catch {
		// Timeout, DNS, or Open-Meteo being down. The card removes itself when
		// this fails, so a quiet 502 is the right answer.
		return json({ error: "upstream" }, 502, 60);
	}

	const reading = readingOf(place, body);
	if (!reading) return json({ error: "upstream" }, 502, 60);
	cacheSet(key, JSON.stringify(body), TTL_SECONDS);
	return json(reading, 200, TTL_SECONDS);
}
