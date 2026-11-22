/**
 * post-types.ts — one-off: post types become News / Fact check / Opinion, and
 * "alert" becomes a separate yes/no field.
 *
 * Schema (through EmDash's SchemaRegistry, so field rows and columns agree):
 *   - `kicker` → label "Post type", options news | fact_check | opinion,
 *     default news, radio editor from the post-editor plugin
 *   - new boolean `alert` ("Show as alert")
 *   - fact-check fields get editors that only show on fact checks
 *   - field order: title, post type, alert, excerpt, content, image, fact
 *     check fields, SEO description
 *
 * Data:
 *   - kicker "alert"        → news, alert = 1
 *   - kicker null / "none"  → news, or opinion when the post is in the
 *     Opinion category
 *
 * Every post's old kicker is saved first to
 * migration/post-types-backup-<branch>-<time>.json.
 *
 *   pnpm tsx scripts/post-types.ts                   # dry run, dev
 *   pnpm tsx scripts/post-types.ts --database=prod --apply
 *
 * After --apply on prod, bump the schema cache (the script prints the
 * wrangler commands) so the admin picks the new fields up straight away.
 * Idempotent.
 */
import { writeFileSync } from "node:fs";
import { createDialect } from "emdash/db/postgres";
import type { Database } from "emdash";
import { SchemaRegistry } from "emdash";
import { Kysely, sql } from "kysely";
import { parseArgs, wantsHelp } from "./lib/migration-db";

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
	console.log("pnpm tsx scripts/post-types.ts [--database=dev|prod] [--apply]");
	process.exit(0);
}
const flags = parseArgs(argv);
const connectionString =
	flags.branch === "prod"
		? process.env.NEON_DATABASE_URL
		: process.env.NEON_DEV_DATABASE_URL || process.env.NEON_DATABASE_URL;
if (!connectionString) throw new Error(`No connection string for ${flags.branch}`);

const db = new Kysely<Database>({ dialect: createDialect({ connectionString }) });
const registry = new SchemaRegistry(db);
const W = (name: string) => `checkclimate-post-editor:${name}`;

const FIELD_ORDER = [
	"title",
	"kicker",
	"alert",
	"excerpt",
	"content",
	"featured_image",
	"claim",
	"claim_source",
	"verdict",
	"verdict_summary",
	"verdict_note",
	"at_a_glance",
	"sources",
	"seo_description",
];

const FACT_CHECK_WIDGETS: Record<string, string> = {
	claim: "fc-heading-text",
	claim_source: "fc-text",
	verdict: "fc-verdict",
	verdict_summary: "fc-textarea",
	verdict_note: "fc-textarea",
	at_a_glance: "fc-list",
	sources: "fc-sources",
};

try {
	const before = await sql<{ kicker: string | null; n: number }>`
		select kicker, count(*)::int as n from ec_posts where deleted_at is null group by 1 order by 1`.execute(db);
	console.log("kicker before:", JSON.stringify(before.rows));

	const opinion = await sql<{ id: string }>`
		select distinct p.id from ec_posts p
		join content_taxonomies ct on ct.entry_id = p.id and ct.collection = 'posts'
		join taxonomies t on t.id = ct.taxonomy_id
		where t.name = 'category' and t.slug = 'opinion'
			and (p.kicker is null or p.kicker in ('none', 'news'))`.execute(db);
	const alerts = await sql<{ id: string; slug: string }>`
		select id, slug from ec_posts where kicker = 'alert'`.execute(db);
	console.log(`alerts → news + alert: ${alerts.rows.map((r) => r.slug).join(", ") || "none"}`);
	console.log(`opinion-category posts → opinion: ${opinion.rows.length}`);

	const posts = await registry.getCollectionWithFields("posts");
	const hasAlert = posts?.fields.some((field) => field.slug === "alert") ?? false;
	console.log(`alert field exists: ${hasAlert}`);

	if (!flags.apply) {
		console.log("\nDry run: nothing written. Add --apply to write.");
	} else {
		const all = await sql<{ id: string; slug: string; kicker: string | null }>`
			select id, slug, kicker from ec_posts`.execute(db);
		const file = `migration/post-types-backup-${flags.branch}-${Date.now()}.json`;
		writeFileSync(file, JSON.stringify(all.rows, null, "\t"));
		console.log(`backup: ${file}`);

		// Schema first for the new column, then data, then the stricter options.
		if (!hasAlert) {
			await registry.createField("posts", {
				slug: "alert",
				label: "Show as alert",
				type: "boolean",
				defaultValue: false,
			});
		}

		await db.transaction().execute(async (trx) => {
			await sql`update ec_posts set alert = 1, kicker = 'news' where kicker = 'alert'`.execute(trx);
			if (opinion.rows.length > 0) {
				await sql`update ec_posts set kicker = 'opinion' where id in (${sql.join(
					opinion.rows.map((row) => row.id),
				)})`.execute(trx);
			}
			await sql`update ec_posts set kicker = 'news' where kicker is null or kicker = 'none'`.execute(trx);
			await sql`update ec_posts set alert = 0 where alert is null`.execute(trx);
		});

		await registry.updateField("posts", "kicker", {
			label: "Post type",
			defaultValue: "news",
			validation: { options: ["news", "fact_check", "opinion"] },
			widget: W("post-type"),
		});
		for (const [slug, widget] of Object.entries(FACT_CHECK_WIDGETS)) {
			await registry.updateField("posts", slug, { widget: W(widget) });
		}

		const present = new Set(
			((await registry.getCollectionWithFields("posts"))?.fields ?? []).map((field) => field.slug),
		);
		const order = [...FIELD_ORDER.filter((slug) => present.has(slug)), ...[...present].filter((slug) => !FIELD_ORDER.includes(slug))];
		await registry.reorderFields("posts", order);

		const after = await sql<{ kicker: string | null; alert: number | null; n: number }>`
			select kicker, alert, count(*)::int as n from ec_posts where deleted_at is null group by 1, 2 order by 1, 2`.execute(db);
		console.log("after:", JSON.stringify(after.rows));
		console.log("field order:", order.join(", "));

		const now = Date.now();
		console.log(`\nBump the caches so the admin and site see it now:
  pnpm wrangler kv key put --binding CACHE --remote "em:epoch:schema" "${now}"
  pnpm wrangler kv key put --binding CACHE --remote "em:epoch:content:v2:posts" "${now}"
  pnpm wrangler kv key put --binding CACHE --remote "em:epochs-changed" "${now}.${crypto.randomUUID()}"`);
	}
} finally {
	await db.destroy();
}
