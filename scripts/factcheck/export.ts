/**
 * Exports every fact check as numbered paragraphs plus its links, and finds
 * the VERDICT section (extract step 1). Writes <out>/articles.json.
 *   pnpm tsx scripts/factcheck/export.ts --database=prod --out=<dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, parseArgs } from "../lib/migration-db";

const flags = parseArgs(process.argv.slice(2));
const out = String(flags.out ?? "migration/factcheck");
mkdirSync(out, { recursive: true });
const db = await connect(flags.branch);

interface Span { text?: string; marks?: string[] }
interface Block { _type: string; _key?: string; style?: string; listItem?: string; children?: Span[]; markDefs?: Array<{ _key: string; href?: string }> }

/** Credit lines that follow a verdict and stay in the article. */
const SPONSOR = /^this (content|story|article|report|fact[- ]?check) was (produced|written|supported)|independent media response fund|african fact checking alliance/i;
/** "VERDICT" on its own line (some carry zero-width characters). */
const VERDICT = /^\s*(our\s+)?verdict\s*[:.\-–]?\s*$/i;
/** An inline label: "CONCLUSION: The claim … is FALSE." / "VERDICT: The claim …" */
const CONCLUSION = /^\s*(conclusion|verdict)\s*:\s*\S/i;
const clean = (text: string) => text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\[\d+\]/g, "").trim();

const rows = (await db.query(`select id, slug, title, published_at, content from ec_posts where kicker='fact_check' and deleted_at is null order by published_at desc`)).rows;
const articles = rows.map((row) => {
	const blocks: Block[] = typeof row.content === "string" ? JSON.parse(row.content) : row.content ?? [];
	const links: Array<{ n: number; text: string; href: string; para: number }> = [];
	const paras = blocks.map((block, index) => {
		if (block._type !== "block") return { i: index, kind: block._type, text: "" };
		const defs = new Map((block.markDefs ?? []).map((def) => [def._key, def.href ?? ""]));
		let text = "";
		for (const span of block.children ?? []) {
			const link = (span.marks ?? []).map((mark) => defs.get(mark)).find(Boolean);
			if (link) {
				links.push({ n: links.length + 1, text: (span.text ?? "").trim(), href: link, para: index });
				text += `${span.text ?? ""}[${links.length}]`;
			} else text += span.text ?? "";
		}
		return { i: index, kind: block.style && block.style !== "normal" ? block.style : block.listItem ? `li-${block.listItem}` : "p", text: text.trim() };
	});
	let verdictAt = paras.findIndex((p) => p.kind !== "image" && VERDICT.test(clean(p.text)));
	let verdictLabel: "VERDICT" | "CONCLUSION" | null = verdictAt >= 0 ? "VERDICT" : null;
	const verdictParas: number[] = [];
	if (verdictAt >= 0) {
		for (let i = verdictAt + 1; i < paras.length; i += 1) {
			const p = paras[i]!;
			const text = clean(p.text);
			if (!text || /^advertisement$/i.test(text)) continue;
			if (SPONSOR.test(text)) break;
			if (/^h\d$/.test(p.kind)) break;
			verdictParas.push(i);
		}
	} else {
		// No heading: a "CONCLUSION: …" paragraph is the verdict itself.
		// No heading: an inline "CONCLUSION:" / "VERDICT:" paragraph opens the
		// verdict, which runs until the credit line.
		const at = paras.findIndex((p) => p.kind === "p" && CONCLUSION.test(clean(p.text)));
		if (at >= 0) {
			verdictAt = at;
			verdictLabel = "CONCLUSION";
			for (let i = at; i < paras.length; i += 1) {
				const text = clean(paras[i]!.text);
				if (!text || /^advertisement$/i.test(text)) continue;
				if (SPONSOR.test(text) || /^h\d$/.test(paras[i]!.kind)) break;
				verdictParas.push(i);
			}
		}
	}
	return { id: row.id, slug: row.slug, title: row.title, publishedAt: row.published_at, paras, links, verdictAt, verdictLabel, verdictParas };
});
writeFileSync(`${out}/articles.json`, JSON.stringify(articles, null, "\t"));
console.log(`${articles.length} articles; with VERDICT: ${articles.filter((a) => a.verdictLabel === "VERDICT").length}, CONCLUSION: ${articles.filter((a) => a.verdictLabel === "CONCLUSION").length}; links: ${articles.reduce((s, a) => s + a.links.length, 0)}`);
await db.end();
