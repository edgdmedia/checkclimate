import { describe, expect, it } from "vitest";
import { SITE_DEFAULTS, mergeSiteConfig } from "./site-settings";

describe("mergeSiteConfig", () => {
	it("returns the defaults when nothing is stored", () => {
		expect(mergeSiteConfig({})).toEqual(SITE_DEFAULTS);
	});

	it("prefers stored values over defaults", () => {
		const config = mergeSiteConfig({
			contactEmail: "desk@example.org",
			claimsInbox: "claims@example.org",
			weatherCity: "Accra",
			weatherCountry: "GH",
			weatherLatitude: 5.6037,
			weatherLongitude: -0.187,
		});
		expect(config.contactEmail).toBe("desk@example.org");
		expect(config.claimsInbox).toBe("claims@example.org");
		expect(config.weather).toEqual({
			city: "Accra",
			country: "GH",
			latitude: 5.6037,
			longitude: -0.187,
		});
	});

	it("trims what the form sends", () => {
		expect(mergeSiteConfig({ contactEmail: "  desk@example.org  " }).contactEmail).toBe(
			"desk@example.org",
		);
		expect(mergeSiteConfig({ weatherCity: "  " }).weather.city).toBe(SITE_DEFAULTS.weather.city);
	});

	it("hides a profile the desk cleared, and keeps the others in order", () => {
		const config = mergeSiteConfig({
			xUrl: "",
			whatsappUrl: "https://whatsapp.com/channel/abc",
		});
		// Instagram has no default, so it only appears when it is saved.
		expect(config.socials.map((link) => link.label)).toEqual([
			"Facebook",
			"YouTube",
			"WhatsApp",
		]);
		expect(config.socials.find((link) => link.label === "WhatsApp")?.href).toBe(
			"https://whatsapp.com/channel/abc",
		);
	});

	it("keeps the default profiles for a setting that was never saved", () => {
		expect(mergeSiteConfig({}).socials).toHaveLength(3);
	});

	it("shows no profiles when the desk cleared every one of them", () => {
		const cleared = Object.fromEntries(
			["facebookUrl", "xUrl", "instagramUrl", "youtubeUrl", "whatsappUrl"].map((key) => [
				key,
				"",
			]),
		);
		expect(mergeSiteConfig(cleared).socials).toEqual([]);
	});

	it("ignores values of the wrong type", () => {
		const config = mergeSiteConfig({
			contactEmail: 42,
			weatherLatitude: "8.49",
			weatherLongitude: Number.NaN,
			xUrl: { url: "https://example.org" },
		} as unknown as Record<string, unknown>);
		expect(config.contactEmail).toBe(SITE_DEFAULTS.contactEmail);
		expect(config.weather.latitude).toBe(SITE_DEFAULTS.weather.latitude);
		expect(config.weather.longitude).toBe(SITE_DEFAULTS.weather.longitude);
		expect(config.socials.map((link) => link.label)).toContain("X / Twitter");
	});
});
