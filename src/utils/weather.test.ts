import { describe, expect, it } from "vitest";
import { clockOf, conditionOf, gridOf, placeOf, readingOf } from "./weather";

describe("conditionOf", () => {
	it("maps WMO codes to conditions", () => {
		expect(conditionOf(0)).toBe("clear");
		expect(conditionOf(2)).toBe("partly");
		expect(conditionOf(3)).toBe("cloudy");
		expect(conditionOf(45)).toBe("fog");
		expect(conditionOf(53)).toBe("drizzle");
		expect(conditionOf(63)).toBe("rain");
		expect(conditionOf(81)).toBe("rain");
		expect(conditionOf(75)).toBe("snow");
		expect(conditionOf(95)).toBe("storm");
	});
});

describe("clockOf", () => {
	it("reads the local clock without shifting time zones", () => {
		expect(clockOf("2026-11-21T06:58")).toBe("6:58 am");
		expect(clockOf("2026-11-21T18:43")).toBe("6:43 pm");
		expect(clockOf("2026-11-21T00:05")).toBe("12:05 am");
		expect(clockOf("2026-11-21T12:30")).toBe("12:30 pm");
		expect(clockOf(null)).toBeNull();
	});
});

describe("gridOf", () => {
	it("rounds to a 0.1° grid", () => {
		expect(gridOf(6.4541, 3.3947)).toBe("6.5,3.4");
		expect(gridOf(-1.2921, 36.8219)).toBe("-1.3,36.8");
	});
});

describe("placeOf", () => {
	const none = new URLSearchParams();

	it("uses Cloudflare's location when present", () => {
		expect(
			placeOf({ city: "Lagos", country: "NG", latitude: "6.45", longitude: "3.39" }, none),
		).toEqual({ city: "Lagos", country: "NG", latitude: 6.45, longitude: 3.39 });
	});

	it("falls back to the page's place", () => {
		const params = new URLSearchParams({ lat: "8.4966", lon: "4.5426", city: "Ilorin", country: "NG" });
		expect(placeOf(undefined, params)).toEqual({
			city: "Ilorin",
			country: "NG",
			latitude: 8.4966,
			longitude: 4.5426,
		});
	});

	it("rejects missing or out-of-range coordinates", () => {
		expect(placeOf(undefined, none)).toBeNull();
		expect(placeOf(undefined, new URLSearchParams({ lat: "200", lon: "0" }))).toBeNull();
	});
});

describe("readingOf", () => {
	const place = { city: "Lagos", country: "NG", latitude: 6.45, longitude: 3.39 };

	it("builds a reading from an Open-Meteo response", () => {
		expect(
			readingOf(place, {
				current: {
					temperature_2m: 34.6,
					relative_humidity_2m: 41.2,
					weather_code: 3,
					is_day: 1,
					visibility: 10_000,
				},
				daily: { sunrise: ["2026-11-21T06:58"], sunset: ["2026-11-21T18:43"] },
			}),
		).toEqual({
			city: "Lagos",
			country: "NG",
			temp: 35,
			humidity: 41,
			visibilityKm: 10,
			sunrise: "6:58 am",
			sunset: "6:43 pm",
			condition: "cloudy",
			isDay: true,
			label: "Cloudy",
		});
	});

	it("returns null without temperature or humidity", () => {
		expect(readingOf(place, { current: {} })).toBeNull();
		expect(readingOf(place, null)).toBeNull();
	});
});
