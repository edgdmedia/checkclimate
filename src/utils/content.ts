import type { ContentEntry, InferCollectionData } from "emdash";

export type Post = ContentEntry<InferCollectionData<"posts">>;
export type Term = { slug: string; label: string };

/** ISO timestamp for an entry, falling back to the epoch so URLs stay stable. */
export function publishedAt(post: Post): Date {
	const value = post.data.publishedAt;
	if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.valueOf())) return parsed;
	}
	return new Date(0);
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * WordPress-style URL: /yyyy/mm/dd/slug/
 * Dates are read in UTC so the path never shifts with the server's timezone.
 */
export function postPath(post: Post): string {
	const date = publishedAt(post);
	const slug = post.data.slug ?? post.data.id;
	return `/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${slug}/`;
}

export type PostType = "news" | "fact_check" | "opinion";

/** The post's type (the `kicker` field, labelled "Post type" in the admin). */
export function kickerOf(post: Post): PostType {
	const kicker = post.data.kicker;
	return kicker === "fact_check" || kicker === "opinion" ? kicker : "news";
}

export function isFactCheck(post: Post): boolean {
	return kickerOf(post) === "fact_check";
}

/** "Show as alert": the amber card on the home page and the ALERT: label. */
export function isAlert(post: Post): boolean {
	const alert: unknown = post.data.alert;
	return alert === true || alert === 1;
}

export function kickerPrefix(post: Post): string {
	if (isFactCheck(post)) return "FACT CHECK:";
	if (isAlert(post)) return "ALERT:";
	return "";
}

/**
 * The seven sections and their subcategories (desk decision, 2026-11-22;
 * applied by scripts/taxonomy-reorg.ts). A post carries its section and,
 * where it has one, a subcategory, so a section page lists both.
 */
export const SECTIONS: ReadonlyArray<{ slug: string; label: string; subs: ReadonlyArray<{ slug: string; label: string }> }> = [
	{ slug: "climate", label: "Climate", subs: [
		{ slug: "climate-science", label: "Climate Science" },
		{ slug: "adaptation-resilience", label: "Adaptation & Resilience" },
		{ slug: "climate-disinformation", label: "Climate Disinformation" },
		{ slug: "climate-reporting", label: "Climate Reporting" },
	] },
	{ slug: "weather", label: "Weather", subs: [
		{ slug: "heat", label: "Heat" },
		{ slug: "floods", label: "Floods" },
		{ slug: "wildfires", label: "Wildfires" },
		{ slug: "drought", label: "Drought" },
	] },
	{ slug: "energy", label: "Energy", subs: [
		{ slug: "renewables", label: "Renewables" },
		{ slug: "oil-gas", label: "Oil & Gas" },
	] },
	{ slug: "agriculture", label: "Agriculture", subs: [] },
	{ slug: "environment", label: "Environment", subs: [
		{ slug: "pollution", label: "Pollution" },
		{ slug: "water", label: "Water" },
		{ slug: "nature-wildlife", label: "Nature & Wildlife" },
	] },
	{ slug: "health", label: "Health", subs: [] },
	{ slug: "policy", label: "Policy", subs: [
		{ slug: "climate-finance", label: "Climate Finance" },
		{ slug: "cop-negotiations", label: "COP & Negotiations" },
	] },
];

const SECTION_SLUGS = new Set(SECTIONS.map((section) => section.slug));

/**
 * Fact Check, News and Opinion are post types, not categories; their
 * /category/<slug>/ pages list posts by type.
 */
export const TYPE_SECTIONS: Record<string, { type: PostType; label: string; description: string | null }> = {
	"fact-check": { type: "fact_check", label: "Fact Check", description: "Climate claims circulating across Africa, checked against the evidence." },
	news: { type: "news", label: "News", description: null },
	opinion: { type: "opinion", label: "Opinion", description: null },
};

/** The post's section (top-level category), falling back to any category. */
export function categoryOf(post: Post): Term | null {
	const terms = post.data.terms as Record<string, Term[]> | undefined;
	const categories = terms?.category ?? [];
	return categories.find((term) => SECTION_SLUGS.has(term.slug)) ?? categories[0] ?? null;
}

export function categoriesOf(post: Post): Term[] {
	const terms = post.data.terms as Record<string, Term[]> | undefined;
	return terms?.category ?? [];
}

export function tagsOf(post: Post): Term[] {
	const terms = post.data.terms as Record<string, Term[]> | undefined;
	return terms?.tag ?? [];
}

export function bylinesOf(
	post: Post,
): Array<{ name: string; slug: string | null }> {
	const credits = post.data.bylines as
		| Array<{ byline: { displayName: string; slug?: string | null } }>
		| undefined;
	return (credits ?? []).map((credit) => ({
		name: credit.byline.displayName,
		slug: credit.byline.slug ?? null,
	}));
}

export function primaryByline(post: Post): {
	name: string;
	slug: string | null;
} {
	return bylinesOf(post)[0] ?? { name: "Check Climate", slug: null };
}

/** "Check Climate · Climate Action" style meta line for cards. */
export function metaLine(post: Post): string {
	const tags = tagsOf(post).map((tag) => tag.label);
	const category = categoryOf(post)?.label;
	return [category, ...tags.slice(0, 2)].filter(Boolean).join(" · ");
}

export function titleWithoutKicker(post: Post): string {
	const title =
		typeof post.data.title === "string" ? post.data.title : "Untitled";
	const prefix = kickerPrefix(post);
	if (prefix && title.toUpperCase().startsWith(prefix)) {
		return title.slice(prefix.length).trim();
	}
	return title;
}

export function excerptOf(post: Post): string {
	return typeof post.data.excerpt === "string" ? post.data.excerpt : "";
}

/** Absolute URL for OG tags and share links. */
export function absoluteUrl(origin: string, path: string): string {
	return new URL(path, origin).toString();
}

/** Resolve a media value to an absolute URL for meta tags. */
export function imageUrl(origin: string, image: unknown): string | null {
	if (!image || typeof image !== "object") return null;
	const value = image as Record<string, unknown>;
	if (typeof value.src === "string" && value.src) {
		return value.src.startsWith("http")
			? value.src
			: new URL(value.src, origin).toString();
	}
	const meta = value.meta as Record<string, unknown> | undefined;
	const storageKey =
		(typeof meta?.storageKey === "string" ? meta.storageKey : undefined) ??
		(typeof value.id === "string" ? value.id : undefined);
	if (!storageKey) return null;
	return new URL(
		`/_emdash/api/media/file/${storageKey.split("/").map(encodeURIComponent).join("/")}`,
		origin,
	).toString();
}

/** "At a glance" bullets: the field is JSON, so accept strings or objects. */
export function glanceItems(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) =>
			typeof item === "string"
				? item
				: item && typeof item === "object" && "text" in item
					? String((item as { text: unknown }).text ?? "")
					: "",
		)
		.filter(Boolean);
}

/** Sources: same JSON shape as "At a glance", optionally {text, url}. */
export function sourceItems(
	value: unknown,
): Array<{ text: string; url: string | null }> {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (typeof item === "string") return { text: item, url: null };
			if (item && typeof item === "object") {
				const record = item as Record<string, unknown>;
				return {
					text: String(record.text ?? record.label ?? ""),
					url: typeof record.url === "string" ? record.url : null,
				};
			}
			return { text: "", url: null };
		})
		.filter((item) => item.text);
}