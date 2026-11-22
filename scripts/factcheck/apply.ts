/**
 * Applies approved review decisions (extract step 3).
 *
 *   pnpm tsx scripts/factcheck/apply.ts --dir=<dir> --decisions=<file> [--database=prod] [--apply]
 *
 * <dir>/proposals.json is what plan.ts wrote; <file> is the review page's
 * `decisions` collection as JSON ({ "<slug>": { status, fields?, type? } }).
 *
 * For each approved fact check: writes claim, claim_source, verdict,
 * verdict_summary, verdict_note, sources and at_a_glance (the reviewer's
 * edited values). The article body is never changed: the VERDICT section
 * stays in the text and is only copied into the fields (desk decision,
 * 2026-11-21).
 * For an approved type change: sets the post type.
 * Skipped and undecided posts are not touched. Every touched row's previous
 * values are saved first to migration/factcheck-backup-<branch>-<time>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, parseArgs } from "../lib/migration-db";

interface Fields {
	claim: string; claim_source: string; verdict: string; verdict_summary: string; verdict_note: string;
	sources: Array<{ text: string; url?: string }>; at_a_glance: string[];
}
interface Proposal {
	id: string; slug: string; action: "fill" | "retype"; suggestType: string | null;
	remove: { label: string; blocks: number[] } | null;
}
interface Decision { status: "approved" | "skipped"; fields?: Fields; type?: string }

const VERDICTS = new Set(["False", "Misleading", "False context", "Partly true", "True", "Unproven"]);
const flags = parseArgs(process.argv.slice(2));
const dir = String(flags.dir);
const proposals: Proposal[] = JSON.parse(readFileSync(join(dir, "proposals.json"), "utf8"));
const decisions: Record<string, Decision> = JSON.parse(readFileSync(String(flags.decisions), "utf8"));


const db = await connect(flags.branch);
const backup: unknown[] = [];
const log: string[] = [];
let filled = 0, retyped = 0, skipped = 0;

try {
	await db.query("begin");
	for (const proposal of proposals) {
		const decision = decisions[proposal.slug];
		if (decision?.status !== "approved") { skipped += 1; continue; }

		const row = (await db.query(
			`select id, slug, kicker, claim, claim_source, verdict, verdict_summary, verdict_note, sources, at_a_glance from ec_posts where id = $1`,
			[proposal.id],
		)).rows[0];
		if (!row) { log.push(`! ${proposal.slug}: post not found`); continue; }
		backup.push(row);

		if (proposal.action === "retype") {
			const type = decision.type ?? proposal.suggestType;
			if (type !== "news" && type !== "opinion") { log.push(`! ${proposal.slug}: bad type ${type}`); continue; }
			await db.query(`update ec_posts set kicker = $1 where id = $2`, [type, proposal.id]);
			retyped += 1;
			log.push(`${proposal.slug}: type → ${type}`);
			continue;
		}

		const fields = decision.fields;
		if (!fields) { log.push(`! ${proposal.slug}: approved without fields`); continue; }
		if (fields.verdict && !VERDICTS.has(fields.verdict)) { log.push(`! ${proposal.slug}: verdict "${fields.verdict}"`); continue; }

		const sources = fields.sources.map((s) => (s.url ? { text: s.text, url: s.url } : { text: s.text }));
		await db.query(
			`update ec_posts set claim = $1, claim_source = $2, verdict = $3,
				verdict_summary = $4, verdict_note = $5, sources = $6::jsonb, at_a_glance = $7::jsonb where id = $8`,
			[
				fields.claim || null,
				fields.claim_source || null,
				fields.verdict || null,
				fields.verdict_summary || null,
				fields.verdict_note || null,
				sources.length ? JSON.stringify(sources) : null,
				fields.at_a_glance.length ? JSON.stringify(fields.at_a_glance) : null,
				proposal.id,
			],
		);
		filled += 1;
	}

	console.log(log.join("\n"));
	console.log(`\nfilled ${filled}, retyped ${retyped}, untouched ${skipped} (${flags.branch})`);
	if (flags.apply) {
		const file = `migration/factcheck-backup-${flags.branch}-${Date.now()}.json`;
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
