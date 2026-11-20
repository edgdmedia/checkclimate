/**
 * Shared plumbing for the migration scripts.
 *
 * Both connect straight to Neon with `pg` — no Hyperdrive, no Worker: the
 * import and its checks run locally, where there is no 10 ms CPU cap. Rows are
 * read and written with plain SQL so a change in EmDash's query layer cannot
 * change what a report says.
 */
import { loadEnvFile } from "node:process";
import pg from "pg";

export type Branch = "dev" | "prod";

export interface Database extends pg.Client {
	/** Which Neon branch this connection is on. */
	branch: Branch;
}

export interface CliFlags {
	apply: boolean;
	branch: Branch;
	[key: string]: string | boolean | undefined;
}

/** Reads `--flag`, `--key=value` and `-h`. Unknown flags are kept for the caller. */
export function parseArgs(argv: string[]): CliFlags {
	const flags: CliFlags = { apply: false, branch: "dev" };
	for (const argument of argv) {
		if (!argument.startsWith("--")) continue;
		const [rawKey, rawValue] = argument.slice(2).split("=");
		const key = rawKey!;
		const value = rawValue === undefined ? true : rawValue;
		if (key === "apply" || key === "write") flags.apply = true;
		else if (key === "dry-run") flags.apply = false;
		else if (key === "database" || key === "branch") {
			if (value !== "dev" && value !== "prod") {
				throw new Error(`--database must be dev or prod (got ${String(value)})`);
			}
			flags.branch = value;
		} else flags[key] = typeof value === "boolean" ? value : String(value);
	}
	if (flags.help || flags.h) flags.help = true;
	return flags;
}

function envValue(name: string): string {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Opens a direct connection to one Neon branch.
 *
 * `prod` is what the deployed site reads; `dev` is the working branch the
 * import is normally rehearsed on. The migration connection string is the
 * non-pooled one, which is the only one that can create rows reliably.
 */
export async function connect(branch: Branch): Promise<Database> {
	for (const file of [".env", ".env.local", ".dev.vars"]) {
		try {
			loadEnvFile(file);
		} catch {
			// Missing file is normal; the process environment may still have it.
		}
	}

	const connectionString =
		branch === "prod"
			? envValue("NEON_DATABASE_URL")
			: envValue("NEON_DEV_DATABASE_URL") || envValue("NEON_DATABASE_URL");

	if (!connectionString) {
		throw new Error(
			`No connection string for the ${branch} branch. Set NEON_${branch.toUpperCase()}_DATABASE_URL in .env.`,
		);
	}

	const client = new pg.Client({
		connectionString,
		ssl: { mode: "require" },
		statement_timeout: 120_000,
	}) as Database;
	await client.connect();
	client.branch = branch;
	return client;
}

/** Parses a JSONB column that may already be an object, or be text. */
export function parseJson<T>(value: unknown, fallback: T): T {
	if (value === null || value === undefined || value === "") return fallback;
	if (typeof value === "object") return value as T;
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function wantsHelp(argv: string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

export interface ReportRow {
	slug: string;
	check: string;
	found: string;
	action: "fixed" | "needs a person" | "skipped";
	note?: string;
}

/** Writes the report to stdout, one line per finding, then the counts. */
export function printReport(rows: ReportRow[], dryRun: boolean): void {
	if (rows.length === 0) {
		console.log("Nothing to report: every row passed every check.");
	} else {
		for (const row of rows) {
			const action = dryRun && row.action === "fixed" ? "would fix" : row.action;
			console.log(
				`[${action}] ${row.slug} — ${row.check}: ${row.found}${row.note ? ` (${row.note})` : ""}`,
			);
		}
	}

	const fixed = rows.filter((row) => row.action === "fixed").length;
	const todo = rows.filter((row) => row.action === "needs a person").length;
	const skipped = rows.filter((row) => row.action === "skipped").length;
	console.log(
		`\n${rows.length} findings: ${fixed} changed, ${todo} for an editor, ${skipped} checks skipped.` +
			(dryRun ? " (dry run — nothing was written; pass --apply to write)" : ""),
	);
}
