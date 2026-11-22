/**
 * Site settings, the pure half.
 *
 * The rules for what an editor's setting means, with no EmDash or Workers
 * imports, so they can be unit tested and read from anywhere. `src/utils/site.ts`
 * does the lookup and caches it; this file only merges values over defaults.
 *
 * Three cases per setting, and they are not the same:
 * - absent  → the default in this file (an install that never opened the form)
 * - ""      → deliberately cleared, so hide the thing
 * - a value → use it
 */

export interface SocialLink {
	label: string;
	href: string;
}

export interface WeatherPlace {
	city: string;
	country: string;
	latitude: number;
	longitude: number;
}

export interface SiteConfig {
	contactEmail: string;
	claimsInbox: string;
	socials: SocialLink[];
	weather: WeatherPlace;
}

export const SITE_DEFAULTS: SiteConfig = {
	contactEmail: "CheckClimateAfrica@gmail.com",
	claimsInbox: "CheckClimateAfrica@gmail.com",
	socials: [
		{ label: "Facebook", href: "https://facebook.com" },
		{ label: "X / Twitter", href: "https://twitter.com" },
		{ label: "YouTube", href: "https://youtube.com" },
	],
	weather: { city: "Ilorin", country: "NG", latitude: 8.4966, longitude: 4.5426 },
};

/** Order the profiles appear in, top bar then footer. */
export const SOCIAL_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
	{ key: "facebookUrl", label: "Facebook" },
	{ key: "xUrl", label: "X / Twitter" },
	{ key: "instagramUrl", label: "Instagram" },
	{ key: "youtubeUrl", label: "YouTube" },
	{ key: "whatsappUrl", label: "WhatsApp" },
];

function readString(settings: Record<string, unknown>, key: string): string | null {
	const value = settings[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function readNumber(settings: Record<string, unknown>, key: string): number | null {
	const value = settings[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Merges stored settings over the defaults. */
export function mergeSiteConfig(
	settings: Record<string, unknown>,
	defaults: SiteConfig = SITE_DEFAULTS,
): SiteConfig {
	const socials = SOCIAL_FIELDS.reduce<SocialLink[]>((links, { key, label }) => {
		const stored = settings[key];
		if (stored === "") return links; // the desk cleared it: hide the profile
		const href =
			typeof stored === "string" && stored.trim()
				? stored.trim()
				: (defaults.socials.find((link) => link.label === label)?.href ?? "");
		if (href) links.push({ label, href });
		return links;
	}, []);

	return {
		contactEmail: readString(settings, "contactEmail") ?? defaults.contactEmail,
		claimsInbox: readString(settings, "claimsInbox") ?? defaults.claimsInbox,
		// No extra "if empty use defaults" here: a field that was never saved
		// already fell back to its default above, so an empty list means the desk
		// cleared every profile and the site should show none.
		socials,
		weather: {
			city: readString(settings, "weatherCity") ?? defaults.weather.city,
			country: readString(settings, "weatherCountry") ?? defaults.weather.country,
			latitude: readNumber(settings, "weatherLatitude") ?? defaults.weather.latitude,
			longitude: readNumber(settings, "weatherLongitude") ?? defaults.weather.longitude,
		},
	};
}
