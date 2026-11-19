import type { CacheHint, WhereValue } from "emdash";
import {
	getBylineBySlug,
	getEmDashCollection,
	getTaxonomyTermsWithCacheHint,
} from "emdash";
import type { Post } from "./content";

/** Stories per archive page. Keeps every archive query small for the Worker. */
export const POSTS_PER_PAGE = 10;

export interface ArchiveFilter {
	label: string;
	/** Empty for the "All" chip. */
	slug: string;
	on: boolean;
}

/** Everything the Archive template needs, decided before it renders. */
export interface ArchiveView {
	title: string;
	description: string | null;
	breadcrumbs: Array<{ label: string; href?: string }>;
	posts: Post[];
	page: number;
	hasMore: boolean;
	basePath: string;
	countLabel: string;
	empty: string;
	cacheHints: CacheHint[];
	filters: ArchiveFilter[];
	excludeSection: string | null;
	learnPanel: boolean;
	showClaim: boolean;
}

/** Read the page number from a `/page/[n]/` route param. */
export function pageFromParam(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "1", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Read the topic filter from `?topic=`. */
export function topicFromUrl(url: URL): string | null {
	return url.searchParams.get("topic");
}

async function pageOf(
	page: number,
	where?: Record<string, WhereValue>,
): Promise<{ posts: Post[]; page: number; hasMore: boolean; hints: CacheHint[] }> {
	const safePage =
		Number.isFinite(page) && page > 1 ? Math.floor(page) : 1;
	const result = await getEmDashCollection("posts", {
		where,
		orderBy: { published_at: "desc" },
		limit: POSTS_PER_PAGE,
		offset: (safePage - 1) * POSTS_PER_PAGE,
	});
	return {
		posts: result.entries as Post[],
		page: safePage,
		hasMore: Boolean(result.hasMore),
		hints: [result.cacheHint],
	};
}

/** What every archive must decide; the presentation extras have defaults. */
type ViewCore = Pick<
	ArchiveView,
	| "title"
	| "breadcrumbs"
	| "posts"
	| "page"
	| "hasMore"
	| "basePath"
	| "countLabel"
	| "cacheHints"
>;

function view(
	input: ViewCore & Partial<Omit<ArchiveView, keyof ViewCore>>,
): ArchiveView {
	return {
		description: null,
		filters: [],
		excludeSection: null,
		learnPanel: false,
		showClaim: true,
		empty: "Nothing published here yet.",
		...input,
	};
}

/**
 * Category archive. The term comes from the taxonomy so an unknown slug is a
 * 404 before any HTML is written; the fact-check section adds topic chips
 * built from the real tag terms.
 */
export async function categoryView(
	slug: string,
	page: number,
	topic: string | null,
): Promise<ArchiveView | null> {
	const categories = await getTaxonomyTermsWithCacheHint("category", {
		includeCounts: false,
	});
	const term = categories.data.find((item) => item.slug === slug);
	if (!term) return null;

	const isFactCheck = slug === "fact-check";
	const activeTopic = isFactCheck ? topic : null;

	const where: Record<string, WhereValue> = { category: slug };
	if (activeTopic) where.tag = activeTopic;
	const loaded = await pageOf(page, where);
	const hints = [categories.cacheHint, ...loaded.hints];

	let filters: ArchiveFilter[] = [];
	if (isFactCheck) {
		const tags = await getTaxonomyTermsWithCacheHint("tag", {
			includeCounts: true,
		});
		hints.push(tags.cacheHint);
		filters = [
			{ label: "All", slug: "", on: !activeTopic },
			...tags.data
				.filter((tag) => (tag.count ?? 0) > 0)
				.slice(0, 6)
				.map((tag) => ({
					label: tag.label,
					slug: tag.slug,
					on: activeTopic === tag.slug,
				})),
		];
	}

	return view({
		title: term.label,
		description: isFactCheck
			? "Climate claims circulating across Africa, checked against the evidence."
			: null,
		breadcrumbs: [{ label: "Home", href: "/" }, { label: term.label }],
		posts: loaded.posts,
		page: loaded.page,
		hasMore: loaded.hasMore,
		basePath: `/category/${slug}/`,
		countLabel: activeTopic
			? `Filtered by “${activeTopic}”`
			: `Latest in ${term.label}`,
		cacheHints: hints,
		filters,
		excludeSection: term.label,
		learnPanel: isFactCheck,
		empty: activeTopic
			? `No fact checks tagged “${activeTopic}” yet.`
			: `Nothing published in ${term.label} yet.`,
	});
}

/** Tag archive at /tag/[slug]/. */
export async function tagView(
	slug: string,
	page: number,
): Promise<ArchiveView | null> {
	const terms = await getTaxonomyTermsWithCacheHint("tag", {
		includeCounts: false,
	});
	const term = terms.data.find((item) => item.slug === slug);
	if (!term) return null;

	const loaded = await pageOf(page, { tag: slug });
	return view({
		title: term.label,
		description: null,
		breadcrumbs: [{ label: "Home", href: "/" }, { label: term.label }],
		posts: loaded.posts,
		page: loaded.page,
		hasMore: loaded.hasMore,
		basePath: `/tag/${slug}/`,
		countLabel: `Stories tagged “${term.label}”`,
		cacheHints: [terms.cacheHint, ...loaded.hints],
		excludeSection: null,
		empty: `Nothing tagged “${term.label}” yet.`,
	});
}

/** Author archive at /author/[slug]/. */
export async function authorView(
	slug: string,
	page: number,
): Promise<ArchiveView | null> {
	const byline = await getBylineBySlug(slug);
	if (!byline) return null;

	const loaded = await pageOf(page, { byline: byline.id });
	return view({
		title: byline.displayName,
		description: byline.bio ?? null,
		breadcrumbs: [
			{ label: "Home", href: "/" },
			{ label: "Authors", href: "/authors/" },
			{ label: byline.displayName },
		],
		posts: loaded.posts,
		page: loaded.page,
		hasMore: loaded.hasMore,
		basePath: `/author/${slug}/`,
		countLabel: `Stories by ${byline.displayName}`,
		cacheHints: loaded.hints,
		excludeSection: null,
		empty: `${byline.displayName} has not published yet.`,
	});
}

/** The full story list at /posts/. */
export async function postsView(page: number): Promise<ArchiveView> {
	const loaded = await pageOf(page);
	return view({
		title: "All posts",
		description: "Every story and fact check Check Climate Africa has published.",
		breadcrumbs: [{ label: "Home", href: "/" }, { label: "All posts" }],
		posts: loaded.posts,
		page: loaded.page,
		hasMore: loaded.hasMore,
		basePath: "/posts/",
		countLabel: `Page ${loaded.page}`,
		cacheHints: loaded.hints,
		excludeSection: null,
		showClaim: false,
	});
}

/**
 * Search results. EmDash's full-text index is SQLite-only, so this runs a
 * parameterised ILIKE query over the same connection (src/utils/search.ts).
 * Never cached: the page depends on `?q=` and on the reader, not on content.
 */
export async function searchView(
	query: string,
	page: number,
): Promise<ArchiveView> {
	const { searchPosts } = await import("./search");
	const found = await searchPosts(query, page);
	return view({
		title: query ? `Search: ${query}` : "Search",
		description: null,
		breadcrumbs: [
			{ label: "Home", href: "/" },
			{ label: query ? `Search: ${query}` : "Search" },
		],
		posts: found.posts,
		page: found.page,
		hasMore: found.hasMore,
		basePath: "/search/",
		countLabel: query ? `Results for “${query}”` : "Search Check Climate Africa",
		cacheHints: [],
		excludeSection: null,
		showClaim: false,
		empty: `Nothing matches “${query}”. Try a shorter phrase.`,
	});
}
