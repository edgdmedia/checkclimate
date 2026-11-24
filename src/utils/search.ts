import { sql } from "kysely";
import { getEmDashCollection, getSearchStats, search } from "emdash";
import { getDb } from "emdash/runtime";
import { cacheGet, cacheSet } from "../lib/kv-lite";
import type { Post } from "./content";

/**
 * Public search over published stories.
 *
 * On SQLite, EmDash keeps an FTS5 index per collection. So search asks the index
 * for the matching ids and then hydrates that page through
 * `getEmDashCollection` — the same path every archive list uses, which is what
 * brings terms, bylines and reading time along with it.
 *
 * Two things send a query down the LIKE path instead: content arrives here from
 * Postgres, where the FTS index cannot come along in the copy (search is enabled
 * again after it — see docs/vps-runbook.md), and a Node build whose SQLite lacks
 * FTS5, which EmDash raises as `SearchUnavailableError`. The fallback is the old
 * Postgres ILIKE rewritten for SQLite, where plain `LIKE` is already
 * case-insensitive for ASCII. Whichever path found the ids, the ordering shown
 * to the reader is the same — newest first — so the fallback costs relevance
 * ranking and nothing else.
 */

/** The Kysely handle EmDash's own helpers take, without naming its internal type. */
type Db = Parameters<typeof getSearchStats>[0];

/** Ids to take out of the index per query. The site has a few hundred posts. */
const MAX_MATCHES = 200;

/** How long a "no FTS index here" answer is believed, in seconds. */
const INDEX_TTL_SECONDS = 300;

/** kv-lite key holding "1"/"0" for whether posts has a usable index. */
const INDEX_KEY = "search:posts-indexed";

export interface SearchPage {
	posts: Post[];
	page: number;
	hasMore: boolean;
}

/** Escape LIKE wildcards so a query of "100%" does not match everything. */
function likePattern(term: string): string {
	const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
	return `%${escaped}%`;
}

function tokenize(query: string): string[] {
	return query
		.split(/\s+/)
		.filter(Boolean)
		// Five terms is generous; more only makes the AND harder to satisfy.
		.slice(0, 5);
}

/** One condition per term: the term appears in the title, excerpt or body. */
function termCondition(pattern: string) {
	return sql`(title like ${pattern} or excerpt like ${pattern} or content like ${pattern})`;
}

async function database(): Promise<Db | null> {
	return ((await getDb()) ?? null) as Db | null;
}

/**
 * Whether posts has an FTS index with rows in it.
 *
 * Cheaper than a search that will come back empty, and the answer is cached: a
 * box that has no index does not need to be asked again for five minutes. The
 * negative is what makes the runbook's "enable search, restart is not needed"
 * step true after at most that long.
 */
async function indexed(db: Db): Promise<boolean> {
	const known = cacheGet(INDEX_KEY);
	if (known !== null) return known === "1";
	let ready = false;
	try {
		const stats = await getSearchStats(db);
		ready = (stats.collections.posts?.indexed ?? 0) > 0;
	} catch {
		ready = false;
	}
	cacheSet(INDEX_KEY, ready ? "1" : "0", INDEX_TTL_SECONDS);
	return ready;
}

/** Matching ids from the full-text index, or null when there is no index to ask. */
async function indexedIds(db: Db, query: string): Promise<string[] | null> {
	if (!(await indexed(db))) return null;
	try {
		const found = await search(query, {
			collections: ["posts"],
			limit: MAX_MATCHES,
		});
		return found.items.map((item) => item.id);
	} catch {
		// FTS5 missing from this build, or the text tripped its query syntax.
		return null;
	}
}

/** Matching ids by substring, newest first. The path that needs no index. */
async function scannedIds(db: Db, terms: string[]): Promise<string[]> {
	try {
		const patterns = terms.map(likePattern);
		const found = await sql<{ id: string }>`
			select id
			from ec_posts
			where status = 'published'
				and deleted_at is null
				and ${sql.join(patterns.map(termCondition), sql` and `)}
			order by published_at desc nulls last
			limit ${MAX_MATCHES}
		`.execute(db);
		return found.rows.map((row) => row.id);
	} catch {
		// A search box must never take the site down.
		return [];
	}
}

/**
 * Search published stories, newest first, one page at a time. The matching ids
 * come from the index (or from a scan), then `getEmDashCollection` filters,
 * orders and pages them so templates get terms, bylines and reading time.
 */
export async function searchPosts(
	query: string,
	page = 1,
	perPage = 10,
): Promise<SearchPage> {
	const safePage = Number.isFinite(page) && page > 1 ? Math.floor(page) : 1;
	const terms = tokenize(query);
	if (terms.length === 0) return { posts: [], page: safePage, hasMore: false };

	const db = await database();
	if (!db) return { posts: [], page: safePage, hasMore: false };

	const ids = (await indexedIds(db, query)) ?? (await scannedIds(db, terms));
	if (ids.length === 0) return { posts: [], page: safePage, hasMore: false };

	const { entries, hasMore } = await getEmDashCollection("posts", {
		status: "published",
		where: { id: ids },
		orderBy: { published_at: "desc" },
		limit: perPage,
		offset: (safePage - 1) * perPage,
	});

	return {
		posts: entries as unknown as Post[],
		page: safePage,
		hasMore: Boolean(hasMore),
	};
}
