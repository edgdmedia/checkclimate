/**
 * Site constants, with the editable ones merged over the defaults.
 *
 * `plugins/site-settings` gives the desk a form for the contact address, the
 * claim inbox, the social profiles and the weather city. The rules for what a
 * stored value means live in `site-settings.ts`, next to the defaults; this
 * file does the lookup and keeps it for a minute.
 */
import { env } from "cloudflare:workers";
import { getPluginSettings } from "emdash";
import { SITE_SETTINGS_ID } from "../../plugins/site-settings/src/index";
import {
	mergeSiteConfig,
	SITE_DEFAULTS,
	type SiteConfig,
	type SocialLink,
	type WeatherPlace,
} from "./site-settings";

export type { SiteConfig, SocialLink, WeatherPlace };
export { SITE_DEFAULTS, mergeSiteConfig } from "./site-settings";

/** Fixed URLs in the WordPress shape; not editable. */
export const CLAIM_URL = "/submit-a-claim/";
export const ABOUT_URL = "/about-us/";
export const SEARCH_URL = "/search/";

/**
 * One options-table lookup per minute per isolate. Settings change a few times
 * a year, and the pages that read them are edge-cached for five minutes
 * anyway; an editor's change is visible well inside that.
 */
const SETTINGS_TTL_MS = 60_000;
let cached: { value: SiteConfig; at: number } | null = null;
let pending: Promise<SiteConfig> | null = null;

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
 * The sections in the category bar and the footer. WordPress kept them in a
 * menu; here the taxonomy is the source of truth and this list only gives the
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
