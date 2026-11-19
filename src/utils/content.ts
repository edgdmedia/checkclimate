import type { ContentEntry, InferCollectionData } from "emdash";

export type Post = ContentEntry<InferCollectionData<"posts">>;

/** ISO timestamp for an entry, falling back to the epoch so URLs stay stable. */
export function publishedAt(post: Post): Date {
	const value = post.data.publishedAt;
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.valueOf())) return parsed;
	}
	return new Date(0);
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** WordPress-style URL: /yyyy/mm/dd/slug/ */
export function postPath(post: Post): string {
	const date = publishedAt(post);
	return `/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${post.id}/`;
}

export function kickerOf(post: Post): "none" | "alert" | "fact_check" {
	const kicker = post.data.kicker;
	return kicker === "alert" || kicker === "fact_check" ? kicker : "none";
}

export function isFactCheck(post: Post): boolean {
	return kickerOf(post) === "fact_check";
}

export function kickerPrefix(post: Post): string {
	const kicker = kickerOf(post);
	if (kicker === "fact_check") return "FACT CHECK:";
	if (kicker === "alert") return "ALERT:";
	return "";
}

export function categoryOf(
	post: Post,
): { slug: string; label: string } | null {
	const terms = post.data.terms as
		| Record<string, Array<{ slug: string; label: string }>>
		| undefined;
	const category = terms?.category?.[0];
	return category ? { slug: category.slug, label: category.label } : null;
}

export function tagsOf(post: Post): Array<{ slug: string; label: string }> {
	const terms = post.data.terms as
		| Record<string, Array<{ slug: string; label: string }>>
		| undefined;
	return terms?.tag ?? [];
}

export function bylinesOf(post: Post): Array<{ name: string; slug: string | null }> {
	const credits = post.data.bylines as
		| Array<{ byline: { displayName: string; slug?: string | null } }>
		| undefined;
	return (credits ?? []).map((credit) => ({
		name: credit.byline.displayName,
		slug: credit.byline.slug ?? null,
	}));
}

export function primaryByline(post: Post): { name: string; slug: string | null } {
	return bylinesOf(post)[0] ?? { name: "Check Climate Africa", slug: null };
}

export function titleWithoutKicker(post: Post): string {
	const title = typeof post.data.title === "string" ? post.data.title : "Untitled";
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
		return value.src.startsWith("http") ? value.src : new URL(value.src, origin).toString();
	}
	const meta = value.meta as Record<string, unknown> | undefined;
	const storageKey =
		(typeof meta?.storageKey === "string" ? meta.storageKey : undefined) ??
		(typeof value.id === "string" ? value.id : undefined);
	if (!storageKey) return null;
	return new URL(`/_emdash/api/media/file/${storageKey}`, origin).toString();
}