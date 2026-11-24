#!/usr/bin/env node
/**
 * Copy the site from Neon Postgres into an EmDash SQLite file, row for row.
 *
 *   node scripts/pg-to-sqlite.mjs --target data/migrate.db [--dry-run]
 *
 * Why not EmDash's site transfer: it gives every media file a new storage key
 * (and uploads a second copy to R2) and leaves users and passkeys behind. Both
 * engines run the same EmDash migrations, so the tables are the same and a
 * straight copy keeps every id, media key, user and passkey as they are.
 *
 * The target must be a file EmDash created itself: boot the site once against
 * an empty DATABASE_PATH (migrations + the default collections), then run
 * this. The script refuses a target whose migration list differs from the
 * source's.
 *
 * What it does, in one SQLite transaction:
 *   1. adds columns the source has and the target lacks (fields created in
 *      the admin after launch), with the source's type;
 *   2. drops the triggers (FTS, media usage, redirects), empties each copied
 *      table and inserts the source rows, then recreates the triggers exactly;
 *   3. checks foreign keys and integrity, and compares row counts;
 *   4. switches search back on (Postgres has none, so the source's
 *      search_config is empty) for the collections the fresh site searched,
 *      rebuilding the FTS index with EmDash's FTSManager.
 * _plugin_state is merged, not replaced: plugins new on this build keep
 * their row. Rows the live site writes during the copy are reported as drift;
 * the final run happens with content frozen.
 *
 * The source is read through `psql` in a read-only transaction; nothing is
 * written to Postgres. The connection string comes from NEON_DATABASE_URL
 * (process env, else .env).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// --- arguments ---------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const target = option("--target");
const dryRun = flag("--dry-run");
if (!target) {
	console.error("usage: node scripts/pg-to-sqlite.mjs --target <emdash.db> [--dry-run]");
	process.exit(1);
}
if (!existsSync(target)) {
	console.error(`${target} does not exist: boot the site once against it first`);
	process.exit(1);
}

function sourceUrl() {
	if (process.env.NEON_DATABASE_URL) return process.env.NEON_DATABASE_URL;
	if (existsSync(".env")) {
		const line = readFileSync(".env", "utf8")
			.split(/\r?\n/)
			.find((l) => l.startsWith("NEON_DATABASE_URL="));
		if (line) return line.slice("NEON_DATABASE_URL=".length).replace(/^["']|["']$/g, "");
	}
	throw new Error("NEON_DATABASE_URL is not set (env or .env)");
}
const SOURCE = sourceUrl();

/** Run SQL on the source, read-only; returns stdout lines. */
function psql(sql) {
	const out = execFileSync("psql", [SOURCE, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
		env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
		maxBuffer: 1024 * 1024 * 1024,
		encoding: "utf8",
	});
	return out.split("\n").filter((line) => line.length > 0);
}

// --- what to copy ----------------------------------------------------------------
/**
 * Tables that must not be copied: the target's own bookkeeping, short-lived
 * state, and scratch space. Everything else is copied whole.
 */
const SKIP = new Set([
	"_emdash_migrations", // the target ran the same migrations itself (checked below)
	"_emdash_migrations_lock",
	"_emdash_rate_limits", // counters, meaningless on a new box
	"auth_challenges", // in-flight passkey ceremonies
	"auth_tokens", // pending magic links and invites: issued for the old origin's session
	"_emdash_entry_locks", // editors' open documents
	"_emdash_rooms",
	"_emdash_room_updates", // collaboration scratch
	"_emdash_device_codes",
	"_emdash_authorization_codes",
]);
const isTransferScratch = (table) => table.startsWith("_emdash_transfer_");
/**
 * Tables merged instead of replaced: the source's rows win, and rows only the
 * target has are kept. _plugin_state holds one row per plugin; a plugin that
 * is new on this build (the cache purge) registered itself on first boot and
 * has no row in the source.
 */
const MERGE = new Set(["_plugin_state"]);

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

// Source columns, in order.
const sourceColumns = new Map();
for (const line of psql(
	"select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position",
)) {
	const [table, column, type] = line.split("|");
	if (!sourceColumns.has(table)) sourceColumns.set(table, []);
	sourceColumns.get(table).push({ column, type });
}

const db = new DatabaseSync(target);
const targetColumns = (table) =>
	db.prepare(`select name from pragma_table_info(?)`).all(table).map((row) => row.name);
const targetTables = new Set(
	db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name),
);

// --- preflight -------------------------------------------------------------------
const sourceMigrations = psql("select name from _emdash_migrations order by name");
const targetMigrations = db
	.prepare("select name from _emdash_migrations order by name")
	.all()
	.map((row) => row.name);
if (sourceMigrations.join("\n") !== targetMigrations.join("\n")) {
	const missing = sourceMigrations.filter((name) => !targetMigrations.includes(name));
	const extra = targetMigrations.filter((name) => !sourceMigrations.includes(name));
	console.error("migration lists differ; run the same EmDash version on both sides");
	console.error({ missingOnTarget: missing, extraOnTarget: extra });
	process.exit(1);
}
console.log(`migrations: ${targetMigrations.length} on both sides`);

/** SQLite column type for a source column the target lacks. */
const SQLITE_TYPE = { text: "TEXT", "character varying": "TEXT", integer: "INTEGER", bigint: "INTEGER", real: "REAL", json: "json", bytea: "BLOB" };

const plan = [];
const alterations = [];
for (const [table, columns] of sourceColumns) {
	if (SKIP.has(table) || isTransferScratch(table)) continue;
	if (!targetTables.has(table)) {
		console.error(`table ${table} exists in the source but not in the target`);
		process.exit(1);
	}
	const have = new Set(targetColumns(table));
	for (const { column, type } of columns) {
		if (have.has(column)) continue;
		const sqliteType = SQLITE_TYPE[type];
		if (!sqliteType || !table.startsWith("ec_")) {
			console.error(`column ${table}.${column} (${type}) is missing on the target and is not a collection field`);
			process.exit(1);
		}
		alterations.push(`alter table ${quote(table)} add column ${quote(column)} ${sqliteType}`);
	}
	plan.push({ table, columns });
}

const sourceCount = (table) => Number(psql(`select count(*) from ${quote(table)}`)[0]);
console.log(`columns to add: ${alterations.length}`);
for (const statement of alterations) console.log(`  ${statement}`);
console.log(`tables to copy: ${plan.length}`);
if (dryRun) {
	for (const { table } of plan) console.log(`  ${table}: ${sourceCount(table)} rows`);
	console.log("dry run: nothing written");
	process.exit(0);
}

// --- copy ------------------------------------------------------------------------
/** Select list that makes every value survive JSON: json as text, bytea as base64, bigint as text. */
function selectList(columns) {
	return columns
		.map(({ column, type }) => {
			const name = quote(column);
			if (type === "json") return `${name}::text as ${name}`;
			if (type === "bytea") return `encode(${name}, 'base64') as ${name}`;
			if (type === "bigint") return `${name}::text as ${name}`;
			return name;
		})
		.join(", ");
}

function decode(value, type) {
	if (value === null || value === undefined) return null;
	if (type === "bytea") return Buffer.from(value, "base64");
	if (type === "bigint") {
		const big = BigInt(value);
		return big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(big) : big;
	}
	return value;
}

const triggers = db
	.prepare("select name, sql from sqlite_master where type = 'trigger' and sql is not null order by rowid")
	.all();

// Collections the fresh SQLite site searches. Postgres has no FTS, so the
// source's search_config is empty and the copy switches search off; it is
// switched back on for these after the copy (step 4).
const searchable = db
	.prepare("select slug, search_config from _emdash_collections")
	.all()
	.filter((row) => {
		try {
			return JSON.parse(row.search_config ?? "null")?.enabled === true;
		} catch {
			return false;
		}
	})
	.map((row) => row.slug);

const report = [];
db.exec("pragma foreign_keys = off");
db.exec("begin immediate");
try {
	for (const statement of alterations) db.exec(statement);
	for (const { name } of triggers) db.exec(`drop trigger ${quote(name)}`);

	for (const { table, columns } of plan) {
		const before = db.prepare(`select count(*) as n from ${quote(table)}`).get().n;
		const merge = MERGE.has(table);
		if (!merge) db.exec(`delete from ${quote(table)}`);
		const names = columns.map(({ column }) => quote(column)).join(", ");
		const insert = db.prepare(
			`insert ${merge ? "or replace " : ""}into ${quote(table)} (${names}) values (${columns.map(() => "?").join(", ")})`,
		);
		const rows = psql(`select row_to_json(t)::text from (select ${selectList(columns)} from ${quote(table)}) t`);
		for (const line of rows) {
			const row = JSON.parse(line);
			insert.run(...columns.map(({ column, type }) => decode(row[column], type)));
		}
		report.push({ table, targetBefore: before, source: rows.length, merge });
	}

	for (const { sql } of triggers) db.exec(sql);
	db.exec("commit");
} catch (error) {
	db.exec("rollback");
	db.exec("pragma foreign_keys = on");
	console.error("copy failed, nothing written:", error);
	process.exit(1);
}
db.exec("pragma foreign_keys = on");

// --- verify ----------------------------------------------------------------------
let failed = false;
for (const entry of report) {
	entry.target = db.prepare(`select count(*) as n from ${quote(entry.table)}`).get().n;
	// Compare with what was read, not with the source now: the live site keeps
	// writing (a 404 logged mid-copy is not a failed copy). A merged table holds
	// the source's rows plus the target's own.
	if (entry.merge ? entry.target < entry.source : entry.target !== entry.source) failed = true;
	entry.check = sourceCount(entry.table);
}
const drifted = report.filter((entry) => entry.check !== entry.source);
if (drifted.length > 0) {
	console.log("changed in the source while copying (re-run at cutover, with content frozen):");
	for (const { table, source, check } of drifted) console.log(`  ${table}: copied ${source}, now ${check}`);
}
console.table(
	report
		.filter((entry) => entry.source > 0 || entry.target > 0 || entry.targetBefore > 0)
		.map(({ table, targetBefore, source, target: after, check }) => ({ table, seedRows: targetBefore, copied: source, now: after, sourceNow: check })),
);

const triggersAfter = db.prepare("select count(*) as n from sqlite_master where type = 'trigger'").get().n;
if (triggersAfter !== triggers.length) {
	console.error(`triggers: ${triggersAfter} after, ${triggers.length} before`);
	failed = true;
}
const foreignKeys = db.prepare("pragma foreign_key_check").all();
if (foreignKeys.length > 0) {
	console.error("foreign key violations:", foreignKeys.slice(0, 20));
	failed = true;
}
const integrity = db.prepare("pragma integrity_check").all().map((row) => Object.values(row)[0]);
if (integrity.join() !== "ok") {
	console.error("integrity_check:", integrity.slice(0, 20));
	failed = true;
}
console.log(`triggers restored: ${triggersAfter}; foreign keys: ${foreignKeys.length} violations; integrity: ${integrity.join()}`);
db.close();
if (failed) {
	console.error("VERIFY FAILED");
	process.exit(1);
}
console.log("copy verified: every copied table holds exactly the rows read from the source");

// --- 4. search back on ---------------------------------------------------------
// EmDash's own FTSManager, the code path the admin's "enable search" uses:
// it rebuilds the index from the copied rows and writes search_config.
const { Kysely } = await import("kysely");
const { FTSManager } = await import("emdash");
const { createDialect } = await import("emdash/db/sqlite");
const kysely = new Kysely({ dialect: createDialect({ url: target }) });
try {
	const fts = new FTSManager(kysely);
	for (const slug of searchable) {
		await fts.enableSearch(slug);
		console.log(`search on for ${slug}: ${(await fts.getIndexStats(slug))?.indexed ?? 0} rows indexed`);
	}
} finally {
	await kysely.destroy();
}
