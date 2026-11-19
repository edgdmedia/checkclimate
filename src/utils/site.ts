/** Shared site constants. Editable ones arrive in phase 4 (site settings). */
export const CONTACT_EMAIL = "CheckClimateAfrica@gmail.com";
export const CLAIM_URL = "/submit-a-claim/";
export const ABOUT_URL = "/about-us/";
export const SEARCH_URL = "/search/";

export const SOCIAL_LINKS = [
	{ label: "Facebook", href: "https://facebook.com" },
	{ label: "X / Twitter", href: "https://twitter.com" },
	{ label: "YouTube", href: "https://youtube.com" },
] as const;

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
