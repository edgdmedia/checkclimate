import type { Kysely } from "kysely";
import { sql } from "kysely";
import { getEmDashCollection } from "emdash";
import { getDb } from "emdash/runtime";
import type { Post } from "./content";

/**
 * Postgres search over the posts table.
 *
 * EmDash's `search()` helper is SQLite FTS5 only, so public search runs a
 * parameterised ILIKE query on the same request-scoped Kysely connection the
 * CMS uses (Hyperdrive in production, the local Neon branch in dev). Every
 * term, limit and offset is a bind parameter; only fixed column names and
 * operators are written into the SQL text.
 */

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
	return sql`(title ilike ${pattern} or excerpt ilike ${pattern} or content::text ilike ${pattern})`;
}

/**
 * Search published stories, newest first, one page at a time. The matching
 * ids come back from SQL, then the same page is hydrated through
 * `getEmDashCollection` so templates get terms, bylines and reading time.
 */
export async function searchPosts(
	query: string,
	page = 1,
	perPage = 10,
): Promise<SearchPage> {
	const terms = tokenize(query);
	const safePage = Number.isFinite(page) && page > 1 ? Math.floor(page) : 1;
	if (terms.length === 0) return { posts: [], page: safePage, hasMore: false };

	const db = (await getDb()) as unknown as Kysely<Record<string, never>> | null;
	if (!db) return { posts: [], page: safePage, hasMore: false };

	let rows: Array<{ id: string }>;
	try {
		const patterns = terms.map(likePattern);
		const result = await sql<{ id: string }>`
			select id
			from ec_posts
			where status = 'published'
				and deleted_at is null
				and ${sql.join(patterns.map(termCondition), sql` and `)}
			order by published_at desc nulls last
			limit ${perPage + 1}
			offset ${(safePage - 1) * perPage}
		`.execute(db);
		rows = result.rows;
	} catch {
		// A search box must never take the site down.
		return { posts: [], page: safePage, hasMore: false };
	}

	const hasMore = rows.length > perPage;
	const ordered = rows.slice(0, perPage).map((row) => row.id);
	if (ordered.length === 0) return { posts: [], page: safePage, hasMore };

	const hydrated = await getEmDashCollection("posts", {
		where: { id: ordered },
		limit: ordered.length,
		offset: 0,
	});

	// Keep the SQL order (newest first).
	const byId = new Map(
		(hydrated.entries as Post[]).map((post) => [post.data.id, post]),
	);
	const posts = ordered
		.map((id) => byId.get(id))
		.filter((post): post is Post => Boolean(post));

	return { posts, page: safePage, hasMore };
}
