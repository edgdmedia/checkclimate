/**
 * unwrap-wayback-links.ts — point every Wayback-wrapped link back at its original.
 *
 * The Wayback wrappers in the content came from restoring the WordPress site
 * after a data loss, so a link like
 *   https://web.archive.org/web/20250318160154/http://www.globalfuturecities.org/…
 * becomes
 *   http://www.globalfuturecities.org/…
 * Own-site originals become root-relative paths. Images are not touched (see
 * unwrapLink in lib/wayback.ts); unwrap-wayback.ts owns own-site images.
 *
 *   pnpm tsx scripts/unwrap-wayback-links.ts                  # dry run, dev branch
 *   pnpm tsx scripts/unwrap-wayback-links.ts --database=prod  # dry run, production
 *   pnpm tsx scripts/unwrap-wayback-links.ts --database=prod --apply
 *
 * With --apply, the original content of every changed row is saved first to
 * migration/unwrap-wayback-links-backup-<branch>-<time>.json. Idempotent: a
 * second run finds nothing to change.
 */
import { writeFileSync } from "node:fs";
import { connect, parseArgs, parseJson, wantsHelp } from "./lib/migration-db";
import { unwrapLinksInContent } from "./lib/wayback";

const HELP = `unwrap-wayback-links.ts

  --apply                 write the rewrites (default: dry run)
  --database=<dev|prod>   Neon branch (default: dev)
  --verbose               print every rewritten link
  --help                  this message
`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
	console.log(HELP);
	process.exit(0);
}
const flags = parseArgs(argv);
const db = await connect(flags.branch);

let changedRows = 0;
let changedLinks = 0;
const backup: Array<{ table: string; id: string; slug: string; content: unknown }> = [];
const updates: Array<{ table: string; id: string; content: unknown }> = [];

try {
	for (const table of ["ec_posts", "ec_pages"] as const) {
		const { rows } = await db.query<{ id: string; slug: string; content: unknown }>(
			`select id, slug, content from ${table} where content::text like '%web.archive.org%' order by slug`,
		);
		for (const row of rows) {
			const original = typeof row.content === "string" ? row.content : JSON.stringify(row.content);
			const content = parseJson<unknown>(original, null);
			const changes = unwrapLinksInContent(content);
			if (changes.length === 0) continue;
			changedRows += 1;
			changedLinks += changes.length;
			console.log(`${table} ${row.slug}: ${changes.length} link(s)`);
			if (flags.verbose) for (const change of changes) console.log(`    ${change.from}\n  → ${change.to}`);
			backup.push({ table, id: row.id, slug: row.slug, content: JSON.parse(original) });
			updates.push({ table, id: row.id, content });
		}
	}

	console.log(`\n${changedLinks} link(s) in ${changedRows} row(s) on ${flags.branch}.`);

	if (!flags.apply) {
		console.log("Dry run: nothing written. Add --apply to write.");
	} else if (updates.length > 0) {
		const file = `migration/unwrap-wayback-links-backup-${flags.branch}-${Date.now()}.json`;
		writeFileSync(file, JSON.stringify(backup, null, "\t"));
		console.log(`Backup of the original rows: ${file}`);
		await db.query("begin");
		for (const update of updates) {
			await db.query(`update ${update.table} set content = $1::jsonb where id = $2`, [
				JSON.stringify(update.content),
				update.id,
			]);
		}
		await db.query("commit");
		console.log(`Written: ${updates.length} row(s).`);
	}
} catch (error) {
	await db.query("rollback").catch(() => {});
	throw error;
} finally {
	await db.end();
}
