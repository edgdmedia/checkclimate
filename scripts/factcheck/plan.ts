/**
 * Builds the review proposals (extract step 2): article export + drafted
 * fields → <dir>/proposals.json, one entry per fact check.
 *
 *   pnpm tsx scripts/factcheck/plan.ts --dir=<dir>
 *
 * Verdict summary and note come from the article's own VERDICT (or
 * CONCLUSION) paragraphs — first paragraph is the summary (merged with the
 * next when it is only a one-line "The claim is false."), the rest is the
 * note. A draft's verdict_summary is used only when the article has no
 * verdict section. Source link numbers resolve to the article's own hrefs.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../lib/migration-db";

const VERDICTS = ["False", "Misleading", "False context", "Partly true", "True", "Unproven"];

interface Para { i: number; kind: string; text: string }
interface Article {
	id: string; slug: string; title: string; publishedAt: string;
	paras: Para[]; links: Array<{ n: number; text: string; href: string }>;
	verdictAt: number; verdictLabel: "VERDICT" | "CONCLUSION" | null; verdictParas: number[];
}
interface Draft {
	slug: string; claim?: string; claim_source?: string; verdict?: string;
	verdict_summary?: string; verdict_note?: string;
	sources?: Array<{ n: number; text: string }>; at_a_glance?: string[];
	suggest_type?: "news" | "opinion"; note?: string;
}

const flags = parseArgs(process.argv.slice(2));
const dir = String(flags.dir);
const articles: Article[] = JSON.parse(readFileSync(join(dir, "articles.json"), "utf8"));
const drafts = new Map<string, Draft>();
for (const file of readdirSync(dir).filter((f) => /^drafts-\d+\.json$/.test(f)).sort()) {
	for (const draft of JSON.parse(readFileSync(join(dir, file), "utf8")) as Draft[]) drafts.set(draft.slug, draft);
}

const clean = (text: string) =>
	text
		.replace(/[​-‍﻿]/g, "")
		.replace(/\[\d+\]/g, "")
		.replace(/\s*Advertisement\s*$/i, "")
		.replace(/^\s*(conclusion|verdict)\s*:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();

function postUrl(article: Article): string {
	const date = new Date(article.publishedAt);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${article.slug}/`;
}

const problems: string[] = [];
const proposals = articles.map((article) => {
	const draft = drafts.get(article.slug);
	if (!draft) problems.push(`no draft: ${article.slug}`);
	const base = { id: article.id, slug: article.slug, title: article.title, url: postUrl(article), note: draft?.note ?? null };

	if (draft?.suggest_type) {
		return { ...base, action: "retype" as const, suggestType: draft.suggest_type, fields: null, remove: null, verdictText: null };
	}

	const verdictParas = article.verdictParas.map((i) => clean(article.paras[i]!.text)).filter(Boolean);
	let summary = draft?.verdict_summary ?? "";
	let note = draft?.verdict_note ?? "";
	if (verdictParas.length > 0) {
		const [first, ...rest] = verdictParas;
		if (first!.length < 80 && rest.length > 0) {
			summary = `${first} ${rest.shift()}`;
		} else summary = first!;
		note = rest.join("\n\n");
	}

	const byNumber = new Map(article.links.map((link) => [link.n, link.href]));
	const sources = (draft?.sources ?? []).flatMap((source) => {
		const href = byNumber.get(source.n);
		if (!href) {
			problems.push(`${article.slug}: source [${source.n}] not in the article`);
			return [];
		}
		return [{ text: source.text, url: href }];
	});

	if (draft?.verdict && !VERDICTS.includes(draft.verdict)) problems.push(`${article.slug}: verdict "${draft.verdict}"`);
	if (!summary) problems.push(`${article.slug}: no verdict summary`);

	return {
		...base,
		action: "fill" as const,
		suggestType: null,
		fields: {
			claim: draft?.claim ?? "",
			claim_source: draft?.claim_source ?? "",
			verdict: draft?.verdict ?? "",
			verdict_summary: summary,
			verdict_note: note,
			sources,
			at_a_glance: draft?.at_a_glance ?? [],
		},
		remove:
			article.verdictLabel !== null
				? { label: article.verdictLabel, blocks: [...new Set([article.verdictAt, ...article.verdictParas])].filter((i) => i >= 0) }
				: null,
		verdictText: verdictParas.join("\n\n") || null,
	};
});

writeFileSync(join(dir, "proposals.json"), JSON.stringify(proposals, null, "\t"));
console.log(`${proposals.length} proposals: ${proposals.filter((p) => p.action === "fill").length} fill, ${proposals.filter((p) => p.action === "retype").length} retype; verdict sections to move: ${proposals.filter((p) => p.remove).length}`);
for (const problem of problems) console.log(`  ! ${problem}`);
