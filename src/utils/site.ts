/**
 * Site constants, with the editable ones merged over the defaults.
 *
 * `plugins/site-settings` gives the desk a form for the contact address, the
 * claim inbox, the social profiles and the weather city. Nothing here assumes
 * those rows exist: every read falls back to the default in this file, so an
 * empty setting or a database outage still renders a complete page.
 */
import { env } from "cloudflare:workers";
import { getPluginSettings } from "emdash";
import { SITE_SETTINGS_ID } from "../../plugins/site-settings/src/index";

/** Fixed URLs in the WordPress shape; not editable. */
export const CLAIM_URL = "/submit-a-claim/";
export const ABOUT_URL = "/about-us/";
export const SEARCH_URL = "/search/";

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
const SOCIAL_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
	{ key: "facebookUrl", label: "Facebook" },
	{ key: "xUrl", label: "X / Twitter" },
	{ key: "instagramUrl", label: "Instagram" },
	{ key: "youtubeUrl", label: "YouTube" },
	{ key: "whatsappUrl", label: "WhatsApp" },
];

/**
 * One options-table lookup per minute per isolate. Settings change a few times
 * a year, and the pages that read them are edge-cached for five minutes
 * anyway; an editor's change is visible well inside that.
 */
const SETTINGS_TTL_MS = 60_000;
let cached: { value: SiteConfig; at: number } | null = null;
let pending: Promise<SiteConfig> | null = null;

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

/** Merges stored settings over the defaults. Pure, so it is easy to test. */
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
		socials: socials.length > 0 ? socials : defaults.socials,
		weather: {
			city: readString(settings, "weatherCity") ?? defaults.weather.city,
			country: readString(settings, "weatherCountry") ?? defaults.weather.country,
			latitude: readNumber(settings, "weatherLatitude") ?? defaults.weather.latitude,
			longitude: readNumber(settings, "weatherLongitude") ?? defaults.weather.longitude,
		},
	};
}

async function load(): Promise<SiteConfig> {
	try {
		const config = mergeSiteConfig(await getPluginSettings(SITE_SETTINGS_ID));
		// A Worker var pins the inbox above the admin form: useful when the desk
		// address is an alias only the operator may change.
		const pinned = typeof env.CLAIMS_INBOX === "string" ? env.CLAIMS_INBOX.trim() : "";
		return pinned ? { ...config, claimsInbox: pinned } : config;
	} catch (error) {
		// A settings read must never take a page down.
		console.warn("[site-settings] using defaults:", error);
		return SITE_DEFAULTS;
	}
}

export async function siteConfig(): Promise<SiteConfig> {
	const now = Date.now();
	if (cached && now - cached.at < SETTINGS_TTL_MS) return cached.value;
	if (!pending) {
		pending = load().then((value) => {
			cached = { value, at: Date.now() };
			pending = null;
			return value;
		});
	}
	return pending;
}

/**
 * The sections in the category bar and the footer. WordPress had them in a
 * menu; the taxonomy is the source of truth here, so this list only names the
 * order and the label to show.
 */
export const SECTIONS = [
	{ label: "Fact Check", href: "/category/fact-check/" },
	{ label: "News", href: "/category/news/" },
	{ label: "Agriculture", href: "/category/agriculture/" },
	{ label: "Environment", href: "/category/environment/" },
	{ label: "Green Energy", href: "/category/green-energy/" },
	{ label: "Sustainability", href: "/category/sustainability/" },
	{ label: "Aviation", href: "/category/aviation/" },
] as const;

/** Colour fills used when a story has no featured image. */
export const STORY_FILLS = [
	"var(--brand-forest)",
	"var(--brand-deep)",
	"var(--weather-surface)",
] as const;

export function storyFill(seed: string): string {
	let hash = 0;
	for (let index = 0; index < seed.length; index += 1) {
		hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
	}
	return STORY_FILLS[hash % STORY_FILLS.length] ?? STORY_FILLS[0];
}
