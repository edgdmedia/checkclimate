/**
 * Weather strip logic, shared by the endpoint (/api/weather) and its tests.
 * This replaces the WordPress "EDGD Weather" plugin, which looked up the
 * visitor's city from their IP (ipapi.co) and asked OpenWeatherMap.
 *
 * The page passes the site-settings place as the query string, and
 * `src/components/WeatherCard.astro` may replace the coordinates with the
 * browser's own geolocation when the visitor has already granted it — there is
 * no server-side IP geolocation on this host. Open-Meteo needs no API key.
 */

export type Condition =
	| "clear"
	| "partly"
	| "cloudy"
	| "fog"
	| "drizzle"
	| "rain"
	| "snow"
	| "storm";

export interface Place {
	city: string;
	country: string;
	latitude: number;
	longitude: number;
}

export interface Reading {
	city: string;
	country: string;
	/** °C, rounded. */
	temp: number;
	/** Percent. */
	humidity: number;
	/** Kilometres, one decimal; null when Open-Meteo has no value. */
	visibilityKm: number | null;
	/** Local wall-clock time at the place, e.g. "6:58 am". */
	sunrise: string | null;
	sunset: string | null;
	condition: Condition;
	isDay: boolean;
	label: string;
}

/** WMO weather interpretation codes, as Open-Meteo returns them. */
export function conditionOf(code: number): Condition {
	if (code === 0) return "clear";
	if (code === 1 || code === 2) return "partly";
	if (code === 3) return "cloudy";
	if (code === 45 || code === 48) return "fog";
	if (code >= 51 && code <= 57) return "drizzle";
	if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
	if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
	if (code >= 95) return "storm";
	return "cloudy";
}

const LABELS: Record<Condition, string> = {
	clear: "Clear",
	partly: "Partly cloudy",
	cloudy: "Cloudy",
	fog: "Fog",
	drizzle: "Drizzle",
	rain: "Rain",
	snow: "Snow",
	storm: "Thunderstorm",
};

/**
 * "2026-11-21T06:58" → "6:58 am". Open-Meteo gives sunrise and sunset in the
 * place's own time zone without an offset, so read the clock digits directly
 * instead of letting a Date shift them into the server's zone.
 */
export function clockOf(localIso: string | null | undefined): string | null {
	const match = localIso?.match(/T(\d{2}):(\d{2})/);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = match[2];
	const suffix = hour < 12 ? "am" : "pm";
	const twelve = hour % 12 === 0 ? 12 : hour % 12;
	return `${twelve}:${minute} ${suffix}`;
}

/**
 * Round coordinates to a 0.1° grid (about 11 km) so nearby visitors share one
 * cached reading and one upstream request.
 */
export function gridOf(latitude: number, longitude: number): string {
	return `${latitude.toFixed(1)},${longitude.toFixed(1)}`;
}

export function forecastUrl(latitude: number, longitude: number): string {
	const url = new URL("https://api.open-meteo.com/v1/forecast");
	url.searchParams.set("latitude", latitude.toFixed(2));
	url.searchParams.set("longitude", longitude.toFixed(2));
	url.searchParams.set(
		"current",
		"temperature_2m,relative_humidity_2m,weather_code,is_day,visibility",
	);
	url.searchParams.set("daily", "sunrise,sunset");
	url.searchParams.set("forecast_days", "1");
	url.searchParams.set("timezone", "auto");
	return url.toString();
}

interface OpenMeteo {
	current?: {
		temperature_2m?: number;
		relative_humidity_2m?: number;
		weather_code?: number;
		is_day?: number;
		visibility?: number;
	};
	daily?: { sunrise?: string[]; sunset?: string[] };
}

/** Turn an Open-Meteo response into a reading, or null if it is unusable. */
export function readingOf(place: Place, body: unknown): Reading | null {
	const data = body as OpenMeteo | null;
	const current = data?.current;
	const temp = current?.temperature_2m;
	const humidity = current?.relative_humidity_2m;
	if (typeof temp !== "number" || typeof humidity !== "number") return null;

	const condition = conditionOf(current?.weather_code ?? 3);
	const visibility = current?.visibility;
	return {
		city: place.city,
		country: place.country,
		temp: Math.round(temp),
		humidity: Math.round(humidity),
		visibilityKm:
			typeof visibility === "number" ? Math.round(visibility / 100) / 10 : null,
		sunrise: clockOf(data?.daily?.sunrise?.[0]),
		sunset: clockOf(data?.daily?.sunset?.[0]),
		condition,
		isDay: current?.is_day !== 0,
		label: LABELS[condition],
	};
}

function coordinate(value: unknown): number | null {
	const number = typeof value === "string" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/**
 * The place to report, from what the page passed (the site-settings city) or
 * from the browser's geolocation, which the card substitutes into the same
 * query string when the visitor has already allowed it.
 */
export function placeOf(fallback: URLSearchParams): Place | null {
	const latitude = coordinate(fallback.get("lat"));
	const longitude = coordinate(fallback.get("lon"));
	if (latitude === null || longitude === null) return null;
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
	return {
		city: (fallback.get("city") ?? "").slice(0, 60) || "Your area",
		country: (fallback.get("country") ?? "").slice(0, 3),
		latitude,
		longitude,
	};
}
