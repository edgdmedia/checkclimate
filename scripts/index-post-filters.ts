/**
 * index-post-filters.ts — adds database indexes for the post filters the site
 * queries on: post type (`kicker`) and "Show as alert" (`alert`). Goes through
 * EmDash's SchemaRegistry so the field rows and the index agree.
 *
 *   pnpm tsx --env-file=.env scripts/index-post-filters.ts [--database=prod]
 *
 * Idempotent: fields already marked indexed are skipped.
 */
import { createDialect } from "emdash/db/postgres";
import type { Database } from "emdash";
import { SchemaRegistry } from "emdash";
import { Kysely, sql } from "kysely";
import { parseArgs } from "./lib/migration-db";

const flags = parseArgs(process.argv.slice(2));
const connectionString =
	flags.branch === "prod" ? process.env.NEON_DATABASE_URL : process.env.NEON_DEV_DATABASE_URL || process.env.NEON_DATABASE_URL;
if (!connectionString) throw new Error(`No connection string for ${flags.branch}`);

const db = new Kysely<Database>({ dialect: createDialect({ connectionString }) });
try {
	const registry = new SchemaRegistry(db);
	const posts = await registry.getCollectionWithFields("posts");
	for (const slug of ["kicker", "alert"]) {
		const field = posts?.fields.find((item) => item.slug === slug);
		if (!field) console.log(`${slug}: no such field`);
		else if (field.indexed) console.log(`${slug}: already indexed`);
		else {
			await registry.updateField("posts", slug, { indexed: true });
			console.log(`${slug}: indexed`);
		}
	}
	const indexes = await sql<{ indexdef: string }>`select indexdef from pg_indexes where tablename = 'ec_posts' and (indexdef ilike '%kicker%' or indexdef ilike '%alert%')`.execute(db);
	for (const row of indexes.rows) console.log(" ", row.indexdef);
} finally {
	await db.destroy();
}
