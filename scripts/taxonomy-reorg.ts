/**
 * taxonomy-reorg.ts — one-off: seven categories with subcategories, cleaned
 * tags, and the new primary menu (desk decision, 2026-11-22).
 *
 *   pnpm tsx scripts/taxonomy-reorg.ts --plan=<file> [--database=prod] [--apply]
 *
 * <file> is the reviewed plan: { tree: [{slug,label,subs:[[slug,label]]}],
 * posts: [{slug, cat, sub, tags}] }. For every post the script replaces its
 * category and tag links with: the category, the subcategory (if any) and
 * the tags. Category terms not in the tree and tags no post uses any more are
 * deleted. Existing terms with a matching slug are kept (same id), so their
 * URLs carry on. Old category/tag URLs are not redirected (desk decision).
 *
 * The primary menu becomes Home, Fact Check, News, Opinion, Weather,
 * Agriculture, Environment, Energy, Policy. Fact Check / News / Opinion are
 * post types; src/utils/archive.ts serves their /category/ pages by type.
 *
 * Everything runs in one transaction; the previous terms, links and menu are
 * saved first to migration/taxonomy-backup-<branch>-<time>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { slugify, ulid } from "emdash";
import { connect, parseArgs } from "./lib/migration-db";

interface Plan {
	tree: Array<{ slug: string; label: string; subs: Array<[string, string]> }>;
	posts: Array<{ slug: string; cat: string; sub: string; tags: string[] }>;
}

const MENU: Array<[string, string]> = [
	["Home", "/"],
	["Fact Check", "/category/fact-check/"],
	["News", "/category/news/"],
	["Opinion", "/category/opinion/"],
	["Weather", "/category/weather/"],
	["Agriculture", "/category/agriculture/"],
	["Environment", "/category/environment/"],
	["Energy", "/category/energy/"],
	["Policy", "/category/policy/"],
];

const flags = parseArgs(process.argv.slice(2));
const plan: Plan = JSON.parse(readFileSync(String(flags.plan), "utf8"));
const db = await connect(flags.branch);
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
	(await db.query(text, values)).rows as T[];

try {
	await db.query("begin");

	// --- backup ---------------------------------------------------------------
	const backup = {
		terms: await q(`select * from taxonomies where name in ('category','tag')`),
		links: await q(`select ct.* from content_taxonomies ct join taxonomies t on t.id = ct.taxonomy_id where t.name in ('category','tag')`),
		menu: await q(`select i.* from _emdash_menu_items i join _emdash_menus m on m.id = i.menu_id where m.name = 'primary'`),
	};

	const existing = new Map<string, { id: string; slug: string; label: string; parent_id: string | null }>();
	for (const term of backup.terms as Array<{ id: string; name: string; slug: string; label: string; parent_id: string | null }>) {
		existing.set(`${term.name}:${term.slug}`, term);
	}

	const insertTerm = async (name: "category" | "tag", slug: string, label: string, parentId: string | null, sortOrder: number) => {
		const found = existing.get(`${name}:${slug}`);
		if (found) {
			await db.query(`update taxonomies set label = $1, parent_id = $2, sort_order = $3 where id = $4`, [label, parentId, sortOrder, found.id]);
			return found.id;
		}
		const id = ulid();
		await db.query(
			`insert into taxonomies (id, name, slug, label, parent_id, data, locale, translation_group, sort_order)
			 values ($1, $2, $3, $4, $5, null, 'en', $1, $6)`,
			[id, name, slug, label, parentId, sortOrder],
		);
		existing.set(`${name}:${slug}`, { id, slug, label, parent_id: parentId });
		return id;
	};

	// --- categories -----------------------------------------------------------
	const categoryIds = new Map<string, string>();
	let order = 0;
	for (const parent of plan.tree) {
		const parentId = await insertTerm("category", parent.slug, parent.label, null, order++);
		categoryIds.set(parent.slug, parentId);
		for (const [slug, label] of parent.subs) {
			categoryIds.set(slug, await insertTerm("category", slug, label, parentId, order++));
		}
	}

	// --- tags -----------------------------------------------------------------
	const tagIds = new Map<string, string>();
	for (const post of plan.posts) {
		for (const label of post.tags) {
			const slug = slugify(label);
			if (!slug || tagIds.has(slug)) continue;
			tagIds.set(slug, await insertTerm("tag", slug, label, null, 0));
		}
	}

	// --- links ----------------------------------------------------------------
	const posts = new Map((await q<{ id: string; slug: string }>(`select id, slug from ec_posts where deleted_at is null`)).map((p) => [p.slug, p.id]));
	let linked = 0;
	for (const post of plan.posts) {
		const entryId = posts.get(post.slug);
		if (!entryId) throw new Error(`post not found: ${post.slug}`);
		await db.query(
			`delete from content_taxonomies where collection = 'posts' and entry_id = $1
			   and taxonomy_id in (select id from taxonomies where name in ('category','tag'))`,
			[entryId],
		);
		const ids = [
			categoryIds.get(post.cat),
			post.sub ? categoryIds.get(post.sub) : undefined,
			...post.tags.map((label) => tagIds.get(slugify(label))),
		].filter((id): id is string => Boolean(id));
		if (!categoryIds.get(post.cat)) throw new Error(`unknown category ${post.cat} for ${post.slug}`);
		for (const id of [...new Set(ids)]) {
			await db.query(`insert into content_taxonomies (collection, entry_id, taxonomy_id) values ('posts', $1, $2)`, [entryId, id]);
			linked += 1;
		}
	}

	// --- prune ----------------------------------------------------------------
	const keepCategories = [...categoryIds.values()];
	const droppedCategories = await q<{ slug: string }>(
		`delete from taxonomies where name = 'category' and not (id = any($1::text[])) returning slug`,
		[keepCategories],
	);
	const droppedTags = await q<{ slug: string }>(
		`delete from taxonomies t where t.name = 'tag'
		   and not exists (select 1 from content_taxonomies ct where ct.taxonomy_id = t.id) returning slug`,
	);
	await db.query(`delete from content_taxonomies where taxonomy_id not in (select id from taxonomies)`);

	// --- menu -----------------------------------------------------------------
	const menu = (await q<{ id: string }>(`select id from _emdash_menus where name = 'primary'`))[0];
	if (!menu) throw new Error("primary menu not found");
	await db.query(`delete from _emdash_menu_items where menu_id = $1`, [menu.id]);
	for (const [index, [label, url]] of MENU.entries()) {
		const id = ulid();
		await db.query(
			`insert into _emdash_menu_items (id, menu_id, parent_id, sort_order, type, custom_url, label, created_at, locale, translation_group)
			 values ($1, $2, null, $3, 'custom', $4, $5, now(), 'en', $1)`,
			[id, menu.id, index, url, label],
		);
	}

	const summary = {
		categories: categoryIds.size,
		tags: tagIds.size,
		links: linked,
		deletedCategories: droppedCategories.length,
		deletedTags: droppedTags.length,
		menu: MENU.map(([label]) => label).join(", "),
	};
	console.log(JSON.stringify(summary, null, 1));

	if (flags.apply) {
		const file = `migration/taxonomy-backup-${flags.branch}-${Date.now()}.json`;
		writeFileSync(file, JSON.stringify(backup, null, "\t"));
		await db.query("commit");
		console.log(`committed; backup ${file}`);
	} else {
		await db.query("rollback");
		console.log("Dry run: rolled back. Add --apply to write.");
	}
} catch (error) {
	await db.query("rollback").catch(() => {});
	throw error;
} finally {
	await db.end();
}
