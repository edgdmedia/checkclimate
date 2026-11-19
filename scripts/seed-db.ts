/**
 * Apply seed/seed.json to PostgreSQL (Neon).
 *
 * The `emdash seed` CLI is SQLite-only, so Postgres projects seed through this
 * script: it opens a direct connection (NEON_DEV_DATABASE_URL by default), runs
 * EmDash's core migrations, validates the seed, applies schema + content, then
 * restores the WordPress-style publish dates from seed/dates.json (EmDash's
 * seed otherwise stamps every published entry with "now", which would break the
 * /yyyy/mm/dd/slug/ URLs) — everything is idempotent by slug.
 *
 * Usage:
 *   pnpm seed                 # apply against NEON_DEV_DATABASE_URL
 *   pnpm seed --url postgres://...   # explicit target (e.g. prod for the import)
 *   pnpm seed --dry-run       # validate + report, change nothing
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDialect } from "emdash/db/postgres";
import { runMigrations } from "emdash/db";
import { applySeed, validateSeed } from "emdash/seed";
import { Kysely, sql } from "kysely";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
	const path = resolve(root, ".env");
	if (!existsSync(path)) return;
	for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key && !process.env[key]) process.env[key] = value;
	}
}

function parseArgs(argv) {
	const args = { dryRun: false, url: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--url") args.url = argv[++i];
	}
	return args;
}

loadEnvFile();
const args = parseArgs(process.argv.slice(2));
const connectionString =
	args.url ?? process.env.NEON_DEV_DATABASE_URL ?? process.env.NEON_DATABASE_URL;

if (!connectionString) {
	console.error(
		"No database URL. Set NEON_DEV_DATABASE_URL in .env, or pass --url postgres://…",
	);
	process.exit(1);
}

const seedPath = resolve(root, "seed/seed.json");
const seedRaw = JSON.parse(readFileSync(seedPath, "utf8"));

const validation = validateSeed(seedRaw);
for (const warning of validation.warnings) console.warn(`warning: ${warning}`);
if (!validation.valid) {
	for (const error of validation.errors) console.error(`error: ${error}`);
	process.exit(1);
}
console.log(`seed ${seedPath} is valid`);

if (args.dryRun) {
	console.log(
		`dry run: would apply ${seedRaw.collections?.length ?? 0} collections, ` +
			`${seedRaw.taxonomies?.length ?? 0} taxonomies, ` +
			`${Object.values(seedRaw.content ?? {}).reduce(
				(sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0),
				0,
			)} content entries to ${redact(connectionString)}`,
	);
	process.exit(0);
}

const db = new Kysely({ dialect: createDialect({ connectionString }) });

try {
	console.log(`target ${redact(connectionString)}`);
	const { applied } = await runMigrations(db);
	console.log(
		applied.length > 0
			? `migrations: applied ${applied.length}`
			: "migrations: up to date",
	);

	const result = await applySeed(db, seedRaw, {
		includeContent: true,
		onConflict: "skip",
		mediaBasePath: resolve(root, "seed"),
		// Seed images resolve to external URLs; media imports land in R2 via the
		// WordPress import, not here.
		skipMediaDownload: true,
	});

	console.log(
		[
			`settings ${result.settings?.applied ?? 0}`,
			`collections ${result.collections?.created ?? 0} created / ${result.collections?.skipped ?? 0} skipped`,
			`fields ${result.fields?.created ?? 0} created`,
			`taxonomies ${result.taxonomies?.created ?? 0} (${result.taxonomies?.terms ?? 0} terms)`,
			`bylines ${result.bylines?.created ?? 0}`,
			`menus ${result.menus?.items ?? 0} items`,
			`content ${result.content?.created ?? 0} created / ${result.content?.skipped ?? 0} skipped`,
		].join("\n  "),
	);

	// Restore the intended WordPress publish dates.
	const datesPath = resolve(root, "seed/dates.json");
	if (existsSync(datesPath)) {
		const dates = JSON.parse(readFileSync(datesPath, "utf8"));
		let updated = 0;
		for (const [slug, date] of Object.entries(dates)) {
			// Collection tables are created per collection; find the posts table
			// that actually carries a published_at column.
			const { rows } = await sql<{ table_name: string }>`
				select table_name from information_schema.columns
				where column_name = 'published_at'
					and table_name ~ '^(ec_)?posts$'
			`.execute(db);
			const table = rows[0]?.table_name;
			if (!table || !/^[a-z_][a-z0-9_]*$/.test(table)) continue;
			const result = await sql`
				update ${sql.id(table)} set published_at = ${new Date(date as string)}
				where slug = ${slug} and published_at is distinct from ${new Date(date as string)}
			`.execute(db);
			updated += Number(result.numAffectedRows ?? 0);
		}
		console.log(`published dates: ${updated}/${Object.keys(dates).length} posts`);
	}
} finally {
	await db.destroy();
}

function redact(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
	} catch {
		return "(invalid url)";
	}
}