/**
 * post-import.ts — the tidy-up pass over imported WordPress content.
 *
 * The EmDash WordPress importer copies posts, pages, images, menus, SEO and
 * comments. It cannot know that Check Climate reads a "Fact Check:" prefix as
 * a kicker, or that a shortcode left in a paragraph will show up as literal
 * brackets on the site. This script finds those and fixes the ones that are
 * safe to fix automatically.
 *
 * Run it from the repo, never on the Worker:
 *
 *   pnpm tsx scripts/post-import.ts                 # dry run, dev branch
 *   pnpm tsx scripts/post-import.ts --database=prod # against production data
 *   pnpm tsx scripts/post-import.ts --apply         # write the safe fixes
 *   pnpm tsx scripts/post-import.ts --slugs=a,b     # one or two rows
 *
 * Dry run is the default and nothing is written without --apply. Every row is
 * reported on its own line; a second run reports the same rows only if they
 * still need something, because each check looks at the current value.
 *
 * What it does with --apply:
 *   - sets `kicker` from the title prefix or the Fact Check category (the only
 *     change it makes; it is a column on the published entry table, so reads
 *     see it at once)
 * Everything else is a report for an editor, because guessing at content is
 * how a migration quietly loses sentences.
 *
 * The `wayback_source_url` postmeta (the Wayback snapshot a restored post was
 * taken from) is deliberately NOT imported — stripping it gives the post's own
 * permalink, which is redundant. When the owner saves those values to
 * migration/wayback-source-urls.json, this script checks each stripped value
 * against the entry's permalink and reports mismatches. Report only.
 */
import { readFileSync } from "node:fs";
import {
	connect,
	parseArgs,
	parseJson,
	printReport,
	wantsHelp,
	type ReportRow,
} from "./lib/migration-db";
import { unwrapWayback } from "./lib/wayback";

interface PostRow {
	id: string;
	slug: string;
	status: string;
	title: string | null;
	excerpt: string | null;
	content: unknown;
	kicker: string | null;
	claim: string | null;
	verdict: string | null;
	verdict_summary: string | null;
	published_at: Date | string | null;
	categories: string[];
}

interface PageRow {
	id: string;
	slug: string;
	status: string;
	title: string | null;
	content: unknown;
}

/** Leftover builder markup that would render as text or as a dead link. */
const BUILDER_PATTERNS: Array<{ token: string; label: string }> = [
	{ token: "wp-content", label: "WordPress media URL" },
	{ token: "wp-includes", label: "WordPress asset URL" },
	{ token: "[elementor-", label: "Elementor shortcode" },
	{ token: "[vc_", label: "WP Bakery shortcode" },
	{ token: "[fusion", label: "Avada shortcode" },
	{ token: "[tm_", label: "Themerex shortcode" },
	{ token: "[raw", label: "raw HTML shortcode" },
	{ token: "[caption", label: "WP caption shortcode" },
	{ token: "[gallery", label: "WP gallery shortcode" },
	{ token: "[embed", label: "WP embed shortcode" },
	{ token: "data-widget_type=", label: "Elementor widget attributes" },
	{ token: "elementor-widget-", label: "Elementor wrapper classes" },
	{ token: "<figure class=\"wp-", label: "WP figure markup" },
	{ token: "<img src=\"data:", label: "inline base64 image" },
];

// Import-time values. scripts/post-types.ts then maps them to the current
// post types (news | fact_check | opinion) plus the separate alert flag.
const KICKER_VALUES = new Set(["none", "alert", "fact_check", "news", "opinion"]);

const HELP = `post-import.ts

  --apply              write the safe fixes (default: dry run)
  --database=<dev|prod>   Neon branch (default: dev)
  --collection=<all|posts|pages>
  --slugs=a,b          only these slugs
  --limit=n            stop after n rows per collection
  --urls=<file>        old WordPress URLs (JSON array or one per line) for the
                       published-date check. Default: migration/old-urls.json
  --wayback=<file>     post's own Wayback source URL per slug (JSON object, an
                       array of {slug,url}, or one URL per line) for the
                       wayback_source_url check. Default:
                       migration/wayback-source-urls.json. Report only — the
                       meta is not imported.
  --help               this message
`;

function asText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

/** First builder pattern in the text, with a short snippet. */
function findBuilderMarkup(text: string): { label: string; token: string; at: number } | null {
	for (const { token, label } of BUILDER_PATTERNS) {
		const at = text.indexOf(token);
		if (at >= 0) return { label, token, at };
	}
	return null;
}

function snippet(text: string, at: number): string {
	const from = Math.max(0, at - 24);
	return text.slice(from, at + 60).replace(/\s+/g, " ").trim();
}

function inferKicker(title: string, categories: string[]): string | null {
	const cleaned = title.trim();
	if (/^fact\s*check\b/i.test(cleaned)) return "fact_check";
	if (/^alert\b/i.test(cleaned)) return "alert";
	if (categories.includes("fact-check")) return "fact_check";
	return null;
}

/** Old WordPress date path (`/2025/07/09/slug/`) by slug. */
function loadOldDates(path: string): Map<string, { year: number; month: number; day: number }> {
	const dates = new Map<string, { year: number; month: number; day: number }>();
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return dates;
	}

	const urls: string[] = raw.trimStart().startsWith("[")
		? (parseJson<string[]>(raw, []))
		: raw.split(/\r?\n/).map((line) => line.trim());

	for (const url of urls) {
		const match = /\/(\d{4})\/(\d{2})\/(\d{2})\/([^/?#]+)\/?$/.exec(url);
		if (!match) continue;
		dates.set(match[4]!, {
			year: Number(match[1]),
			month: Number(match[2]),
			day: Number(match[3]),
		});
	}
	return dates;
}

/** West Africa Time is UTC+1 all year, and that is how WordPress stored it. */
function watParts(value: Date | string | null): { year: number; month: number; day: number } | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(date.getTime())) return null;
	const wat = new Date(date.getTime() + 60 * 60 * 1000); // shift by the +01:00 offset
	return {
		year: wat.getUTCFullYear(),
		month: wat.getUTCMonth() + 1,
		day: wat.getUTCDate(),
	};
}

/**
 * The `wayback_source_url` postmeta by slug, from the owner's export. The
 * importer drops unknown postmeta (it only fills existing schema fields), so
 * the values can only be checked from this file — never from the database.
 *
 * Accepted shapes: a JSON object `{slug: url}`, a JSON array of
 * `{slug, url}` (or `{slug, wayback_source_url}`) or bare URL strings, or one
 * URL per line. For URL-only entries the slug is the last segment of the
 * stripped permalink.
 */
function loadWaybackSources(path: string): Map<string, string[]> {
	const bySlug = new Map<string, string[]>();
	const add = (slug: string, url: string): void => {
		if (!slug || !url) return;
		bySlug.set(slug, [...(bySlug.get(slug) ?? []), url]);
	};
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return bySlug;
	}

	const pushUrl = (url: string): void => {
		const unwrapped = unwrapWayback(url.trim());
		const original = unwrapped?.original ?? url.trim();
		const match = /\/([^/?#]+)\/?$/.exec(original);
		add(match?.[1] ?? "", url.trim());
	};

	if (raw.trimStart().startsWith("{")) {
		const object = parseJson<Record<string, unknown>>(raw, {});
		for (const [slug, value] of Object.entries(object)) add(slug, String(value));
	} else if (raw.trimStart().startsWith("[")) {
		const list = parseJson<unknown[]>(raw, []);
		for (const entry of list) {
			if (typeof entry === "string") pushUrl(entry);
			else if (typeof entry === "object" && entry !== null) {
				const record = entry as Record<string, unknown>;
				const slug = typeof record.slug === "string" ? record.slug : "";
				const url = record.url ?? record.wayback_source_url;
				if (slug && typeof url === "string") add(slug, url);
				else if (typeof url === "string") pushUrl(url);
			}
		}
	} else {
		for (const line of raw.split(/\r?\n/)) {
			if (line.trim()) pushUrl(line);
		}
	}
	return bySlug;
}

/** Paths compare without host or letter case, always with a trailing slash. */
function normalisePath(path: string): string {
	const withoutQuery = path.split(/[?#]/)[0] ?? path;
	return withoutQuery.endsWith("/") ? withoutQuery.toLowerCase() : `${withoutQuery}/`.toLowerCase();
}

/** The permalink the entry should have kept: posts on the date path, pages on the slug. */
function expectedPermalink(
	row: { slug: string; published_at?: Date | string | null },
	isPost: boolean,
): string | null {
	if (!isPost) return `/${row.slug}/`;
	const parts = watParts(row.published_at ?? null);
	if (!parts) return null;
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `/${parts.year}/${pad(parts.month)}/${pad(parts.day)}/${row.slug}/`;
}

/** One report row per wayback_source_url value that does not match the entry. */
function checkWaybackSource(
	slug: string,
	sources: string[],
	expected: string | null,
	rows: ReportRow[],
): void {
	for (const source of sources) {
		const unwrapped = unwrapWayback(source);
		if (!unwrapped) {
			rows.push({
				slug,
				check: "wayback_source_url",
				found: "not a Wayback Machine URL",
				action: "needs a person",
				note: source.slice(0, 80),
			});
			continue;
		}
		if (!expected) {
			rows.push({
				slug,
				check: "wayback_source_url",
				found: "no permalink to compare with (no publish date)",
				action: "skipped",
			});
			continue;
		}
		let actualPath = unwrapped.original;
		try {
			actualPath = new URL(unwrapped.original).pathname;
		} catch {
			// Compare the raw original when it is not a parseable URL.
		}
		if (normalisePath(actualPath) !== normalisePath(expected)) {
			rows.push({
				slug,
				check: "wayback_source_url",
				found: `stripped ${unwrapped.original}`,
				action: "needs a person",
				note: `the entry's permalink is ${expected}`,
			});
		}
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (wantsHelp(argv)) {
		console.log(HELP);
		return;
	}

	const flags = parseArgs(argv);
	const collection = String(flags.collection ?? "all");
	const slugs = flags.slugs ? String(flags.slugs).split(",").map((s) => s.trim()).filter(Boolean) : null;
	const limit = flags.limit ? Number(flags.limit) : null;
	const db = await connect(flags.branch);

	try {
		const oldDates = loadOldDates(String(flags.urls ?? "migration/old-urls.json"));
		if (oldDates.size === 0) {
			console.log(
				"No old WordPress URL list found: the published-date check is skipped. " +
					"Save the sitemap URLs to migration/old-urls.json and re-run.",
			);
		}

		const waybackPath = String(flags.wayback ?? "migration/wayback-source-urls.json");
		const waybackSources = loadWaybackSources(waybackPath);
		if (waybackSources.size === 0) {
			console.log(
				"No wayback_source_url export found: that check is skipped. Save the old postmeta " +
					"(slug → Wayback URL) to migration/wayback-source-urls.json and re-run. The meta is " +
					"never imported; this only checks it against each entry's permalink.",
			);
		}

		const rows: ReportRow[] = [];
		let fixed = 0;

		if (collection !== "pages") {
			const result = await db.query(
				`select p.id, p.slug, p.status, p.title, p.excerpt, p.content, p.kicker,
				        p.claim, p.verdict, p.verdict_summary, p.published_at,
			        coalesce(
			          json_agg(distinct t.slug) filter (where t.slug is not null),
			          '[]'
			        ) as categories
				 from ec_posts p
				 left join content_taxonomies ct on ct.entry_id = p.id and ct.collection = 'posts'
				 left join taxonomies t on t.id = ct.taxonomy_id
				 where p.deleted_at is null
				 group by p.id
				 order by p.published_at desc nulls last, p.slug
				 limit $1`,
				[limit ? Math.max(1, Math.floor(limit)) : 5000],
			);

			for (const raw of result.rows as PostRow[]) {
				if (slugs && !slugs.includes(raw.slug)) continue;
				const title = raw.title ?? "";
				const contentText = asText(raw.content);
				const haystack = `${title}\n${raw.excerpt ?? ""}\n${contentText}`;

				// 1. The kicker the site needs.
				const inferred = inferKicker(title, raw.categories ?? []);
				const stored = raw.kicker;
				if (inferred && stored !== inferred) {
					const willFix = Boolean(flags.apply);
					if (willFix) {
						await db.query(`update ec_posts set kicker = $1 where id = $2`, [inferred, raw.id]);
						fixed += 1;
					}
					rows.push({
						slug: raw.slug,
						check: "kicker",
						found: `${stored ?? "unset"} → ${inferred}`,
						action: "fixed",
						note: willFix ? undefined : "dry run",
					});
				} else if (!inferred && !stored) {
					rows.push({
						slug: raw.slug,
						check: "kicker",
						found: "no prefix, no category, nothing stored",
						action: "skipped",
						note: "left as is; the site shows no kicker",
					});
				} else if (stored && !KICKER_VALUES.has(stored)) {
					rows.push({
						slug: raw.slug,
						check: "kicker",
						found: stored,
						action: "needs a person",
						note: `expected one of ${[...KICKER_VALUES].join(", ")}`,
					});
				}

				// 2. The publish date behind the WordPress URL.
				const expected = oldDates.get(raw.slug);
				if (expected) {
					const actual = watParts(raw.published_at);
					if (!actual) {
						rows.push({
							slug: raw.slug,
							check: "published_at",
							found: "no date",
							action: "needs a person",
							note: `the old URL says ${expected.year}-${expected.month}-${expected.day}`,
						});
					} else if (
						actual.year !== expected.year ||
						actual.month !== expected.month ||
						actual.day !== expected.day
					) {
						rows.push({
							slug: raw.slug,
							check: "published_at",
							found: `${actual.year}-${actual.month}-${actual.day}`,
							action: "needs a person",
							note: `the old URL says ${expected.year}-${expected.month}-${expected.day}`,
						});
					}
				} else if (oldDates.size > 0) {
					rows.push({
						slug: raw.slug,
						check: "published_at",
						found: "no old URL to compare with",
						action: "skipped",
					});
				}

				// 3. Builder markup that survived the conversion.
				const markup = findBuilderMarkup(haystack);
				if (markup) {
					rows.push({
						slug: raw.slug,
						check: "leftover markup",
						found: `${markup.label} at character ${markup.at}`,
						action: "needs a person",
						note: snippet(haystack, markup.at),
					});
				}

				// 3b. The postmeta `wayback_source_url`: the Wayback snapshot the
				// restored post was taken from. Stripped, it should be the post's
				// own permalink. Report only — the meta is not imported.
				const sources = waybackSources.get(raw.slug);
				if (sources) {
					checkWaybackSource(raw.slug, sources, expectedPermalink(raw, true), rows);
				}

				// 4. Fact checks the desk still has to finish.
				const isFactCheck = (raw.kicker ?? inferred) === "fact_check";
				if (isFactCheck) {
					const missing = [
						!raw.claim?.trim() && "claim",
						!raw.verdict?.trim() && "verdict",
						!raw.verdict_summary?.trim() && "verdict summary",
					].filter(Boolean);
					if (missing.length > 0) {
						rows.push({
							slug: raw.slug,
							check: "fact check fields",
							found: `missing ${missing.join(", ")}`,
							action: "needs a person",
						});
					}
				}

				// 5. A story with nothing in it, or nowhere to file it.
				if (!contentText || contentText === "[]" || contentText === '""') {
					rows.push({
						slug: raw.slug,
						check: "content",
						found: "empty body",
						action: "needs a person",
					});
				}
				if ((raw.categories ?? []).length === 0) {
					rows.push({
						slug: raw.slug,
						check: "category",
						found: "no category",
						action: "needs a person",
						note: "section pages and related stories need one",
					});
				}
				if (raw.status !== "published") {
					rows.push({
						slug: raw.slug,
						check: "status",
						found: raw.status,
						action: "needs a person",
						note: "imported rows are expected to be published",
					});
				}
			}
		}

		if (collection !== "posts") {
			const result = await db.query(
				`select id, slug, status, title, content from ec_pages where deleted_at is null order by slug limit $1`,
				[limit ? Math.max(1, Math.floor(limit)) : 5000],
			);
			for (const raw of result.rows as PageRow[]) {
				if (slugs && !slugs.includes(raw.slug)) continue;
				const haystack = `${raw.title ?? ""}\n${asText(raw.content)}`;
				const markup = findBuilderMarkup(haystack);
				if (markup) {
					rows.push({
						slug: raw.slug,
						check: "leftover markup",
						found: `${markup.label} at character ${markup.at}`,
						action: "needs a person",
						note: snippet(haystack, markup.at),
					});
				}
				const pageSources = waybackSources.get(raw.slug);
				if (pageSources) {
					checkWaybackSource(raw.slug, pageSources, expectedPermalink(raw, false), rows);
				}
				if (raw.status !== "published") {
					rows.push({
						slug: raw.slug,
						check: "status",
						found: raw.status,
						action: "needs a person",
					});
				}
			}
		}

		printReport(rows, !flags.apply);
		console.log(
			`Rows changed: ${fixed}. The entry table is what the site reads, so the change is live as soon ` +
				"as it is written; a page already in the Cloudflare cache keeps the old copy until it expires " +
				"(5 minutes) or the editor republishes.",
		);
	} finally {
		await db.end();
	}
}

main().catch((error) => {
	console.error("post-import failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
