/**
 * verify-migration.ts — the go / no-go check on imported content.
 *
 * Answers four questions, in this order, and exits non-zero if any of them
 * fails:
 *
 *   1. Did everything arrive? Published counts against the WordPress sitemap:
 *      172 posts, 6 pages, 36 categories, 277 tags.
 *   2. Does every URL that used to work still work? Each URL from the old
 *      sitemap is requested on the site named by --base, and must answer 200.
 *      Redirects are followed, so the /wp-admin and uploads rules are covered
 *      by the same check.
 *   3. Is any WordPress URL still inside the content? A leftover
 *      `wp-content` link is a broken image waiting for the old site to go away.
 *   4. Is any own-site Wayback Machine URL still wrapped in the content? The
 *      WordPress site was restored from the Wayback Machine and about 875
 *      URLs arrived wrapped. unwrap-wayback.ts rewrites the ones whose
 *      original is on checkclimate.africa (they should point at our own media
 *      library and routes); any that are left — outside the FAILED list from
 *      that script — block here. External Wayback URLs are expected: they are
 *      deliberate archived citations (about 764), counted but never blocking.
 *
 * Read-only: it never writes. Run it from the repo, not on the Worker.
 *
 *   pnpm tsx scripts/verify-migration.ts --database=prod \
 *     --base=https://checkclimate-africa.workers.dev
 *   pnpm tsx scripts/verify-migration.ts --skip-live    # counts and content only
 */
import { readFileSync } from "node:fs";
import {
	connect,
	parseArgs,
	parseJson,
	wantsHelp,
	type ReportRow,
} from "./lib/migration-db";
import {
	collectWaybackEdits,
	extractWrappedUrls,
	isOwnSiteOriginal,
	unwrapWayback,
} from "./lib/wayback";

const EXPECTED = { posts: 172, pages: 6, categories: 36, tags: 277 };
const OLD_SITE = "https://www.checkclimate.africa";
/** Yoast puts posts in numbered sitemaps once there are more than 1000. */
const OLD_SITEMAPS = [
	"/post-sitemap.xml",
	"/page-sitemap.xml",
	"/post-sitemap2.xml",
	"/page-sitemap2.xml",
];
const CONCURRENCY = 8;

const HELP = `verify-migration.ts

  --database=<dev|prod>     Neon branch to count (default: dev)
  --base=<url>              where to request the old URLs (workers.dev preview
                            or production origin). Without it the live check is
                            skipped.
  --skip-live               do not request anything
  --old-site=<url>          WordPress origin the sitemap is read from
                            (default: ${OLD_SITE})
  --urls=<file>             old URLs from a file instead of the live sitemap
  --expect=<file>           JSON {posts,pages,categories,tags} to count against
  --unwrap-failed=<file>    the FAILED list unwrap-wayback.ts wrote with
                            --apply (default: migration/unwrap-wayback-failed.json).
                            Own-site Wayback URLs on it are reported but do
                            not block; they are retried on every unwrap run.
  --help                    this message
`;

interface Counts {
	posts: number;
	pages: number;
	categories: number;
	tags: number;
}

function locs(xml: string): string[] {
	return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]!);
}

async function fetchText(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, { headers: { accept: "application/xml,text/xml" } });
		if (!response.ok) return null;
		return await response.text();
	} catch {
		return null;
	}
}

/** Old WordPress URL → the path the new site serves. */
function toNewPath(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(/\/+$/, "");
		return path ? `${path}/` : "/";
	} catch {
		return "/";
	}
}

/** The slug the new site keys on, from an old post URL. */
function slugFrom(url: string): string | null {
	const match = /\/([^/?#]+)\/?$/.exec(url);
	if (!match) return null;
	const slug = decodeURIComponent(match[1]!);
	return slug === "sample-post" || slug === "hello-world" ? slug : slug;
}

async function checkLive(
	base: string,
	urls: string[],
	rows: ReportRow[],
): Promise<{ ok: number; failed: number }> {
	let ok = 0;
	let failed = 0;
	const queue = [...urls];

	const worker = async () => {
		for (let url = queue.pop(); url; url = queue.pop()) {
			const target = new URL(toNewPath(url), base).toString();
			let status = 0;
			let error = "";
			try {
				const response = await fetch(target, {
					redirect: "follow",
					headers: { "user-agent": "checkclimate-migration-verify" },
					signal: AbortSignal.timeout(30_000),
				});
				status = response.status;
				// Read the body so the connection closes cleanly.
				await response.text().catch(() => "");
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			}

			if (status === 200) {
				ok += 1;
			} else {
				failed += 1;
				rows.push({
					slug: slugFrom(url) ?? url,
					check: "live URL",
					found: `${status || "fetch failed"} ${target}${error ? ` — ${error}` : ""}`,
					action: "needs a person",
				});
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length || 1) }, worker));
	return { ok, failed };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (wantsHelp(argv)) {
		console.log(HELP);
		return;
	}

	const flags = parseArgs(argv);
	const base = flags.base ? String(flags.base).replace(/\/+$/, "") : "";
	const oldSite = String(flags.oldSite ?? OLD_SITE).replace(/\/+$/, "");
	const expected = flags.expect
		? { ...EXPECTED, ...parseJson<Partial<Counts>>(readFileSync(String(flags.expect), "utf8"), {}) }
		: EXPECTED;

	const rows: ReportRow[] = [];
	const db = await connect(flags.branch);

	try {
		// 1. Counts.
		const counts = await db.query(
			`select
			   (select count(*)::int from ec_posts where status = 'published' and deleted_at is null) as posts,
			   (select count(*)::int from ec_pages where status = 'published' and deleted_at is null) as pages,
			   (select count(*)::int from taxonomies where name = 'category') as categories,
			   (select count(*)::int from taxonomies where name = 'tag') as tags`,
		);
		const actual = counts.rows[0] as Counts;
		console.log(
			`counts        posts ${actual.posts}/${expected.posts}  pages ${actual.pages}/${expected.pages}  ` +
				`categories ${actual.categories}/${expected.categories}  tags ${actual.tags}/${expected.tags}`,
		);
		for (const key of ["posts", "pages", "categories", "tags"] as const) {
			if (actual[key] < expected[key]) {
				rows.push({
					slug: key,
					check: "count",
					found: `${actual[key]} of ${expected[key]}`,
					action: "needs a person",
				});
			}
		}

		// 2. Leftover WordPress URLs inside the content.
		const leftovers = await db.query(
			`select slug from ec_posts where deleted_at is null and (
			   content::text like '%wp-content%' or content::text like '%wp-includes%'
			   or excerpt like '%wp-content%' or title like '%wp-content%')
			 union all
			 select slug from ec_pages where deleted_at is null and (
			   content::text like '%wp-content%' or content::text like '%wp-includes%')`,
		);
		console.log(`wp-content  ${leftovers.rows.length} rows still reference the old site`);
		for (const row of leftovers.rows as { slug: string }[]) {
			rows.push({
				slug: row.slug,
				check: "wp-content URL",
				found: "still in content",
				action: "needs a person",
			});
		}

		// 2b. Wayback Machine URLs in the content. External originals are
		// deliberate archived citations — counted, never blocking. An own-site
		// original still wrapped means unwrap-wayback.ts did not get to it (or
		// its download failed and the URL is on the FAILED list, which does
		// not block: every unwrap run retries those).
		const failedPath = String(flags["unwrap-failed"] ?? "migration/unwrap-wayback-failed.json");
		const failed = new Set<string>();
		try {
			const list = parseJson<Array<{ url?: string }>>(readFileSync(failedPath, "utf8"), []);
			for (const entry of list) if (typeof entry?.url === "string") failed.add(entry.url);
		} catch {
			// No FAILED list yet: nothing has failed, or unwrap has not run with --apply.
		}
		const wrappedRows = await db.query(
			`select slug, content, excerpt, title from ec_posts
			 where deleted_at is null and (content::text like '%web.archive.org%'
			   or excerpt like '%web.archive.org%' or title like '%web.archive.org%')
			 union all
			 select slug, content, '' as excerpt, '' as title from ec_pages
			 where deleted_at is null and content::text like '%web.archive.org%'`,
		);
		let externalCount = 0;
		let ownSiteCount = 0;
		let ownSiteOnList = 0;
		const classifyWrapped = (wrapped: string, slug: string, field: string): void => {
			const unwrapped = unwrapWayback(wrapped);
			if (!unwrapped) return;
			if (!isOwnSiteOriginal(unwrapped.original)) {
				externalCount += 1;
				return;
			}
			ownSiteCount += 1;
			if (failed.has(wrapped)) ownSiteOnList += 1;
			rows.push({
				slug,
				check: "own-site Wayback URL",
				found: `still wrapped in ${field}`,
				action: failed.has(wrapped) ? "skipped" : "needs a person",
				note: failed.has(wrapped)
					? "on the FAILED list (download failed); every unwrap-wayback run retries it"
					: `unwrap to ${unwrapped.original}`,
			});
		};
		for (const row of wrappedRows.rows as Array<{ slug: string; content: unknown; excerpt: string; title: string }>) {
			const content = parseJson<unknown>(row.content, null);
			if (Array.isArray(content)) {
				const { fields, strings } = collectWaybackEdits(content);
				for (const occurrence of fields) {
					classifyWrapped(occurrence.wrappedUrl, row.slug, `${occurrence.kind} ${occurrence.field}`);
				}
				for (const stringEdit of strings) {
					for (const wrapped of extractWrappedUrls(stringEdit.html)) {
						classifyWrapped(wrapped, row.slug, `html ${stringEdit.field}`);
					}
				}
			}
			for (const [text, field] of [
				[row.excerpt, "excerpt"],
				[row.title, "title"],
			] as const) {
				for (const wrapped of extractWrappedUrls(text ?? "")) {
					classifyWrapped(wrapped, row.slug, field);
				}
			}
		}
		console.log(
			`wayback     ${ownSiteCount} own-site wrapped URL(s) left` +
				(ownSiteOnList > 0 ? ` — ${ownSiteOnList} on the FAILED list (do not block)` : "") +
				`, ${externalCount} external archived citations (expected)`,
		);

		// 3. The live check.
		let urls: string[] = [];
		if (!flags.skipLive) {
			if (flags.urls) {
				const raw = readFileSync(String(flags.urls), "utf8");
				urls = raw.trimStart().startsWith("[")
					? parseJson<string[]>(raw, [])
					: raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
			} else {
				for (const path of OLD_SITEMAPS) {
					const xml = await fetchText(`${oldSite}${path}`);
					if (xml) urls.push(...locs(xml));
				}
			}
		}

		if (!base) {
			console.log(
				`live URLs   skipped (${urls.length} old URLs collected; pass --base=https://<site> to check them)`,
			);
			if (urls.length === 0) {
				rows.push({
					slug: "sitemap",
					check: "live URL",
					found: "no old URLs collected",
					action: "skipped",
					note: "the WordPress site was unreachable or --skip-live was passed",
				});
			}
		} else {
			const result = await checkLive(base, urls, rows);
			console.log(`live URLs   ${result.ok} ok, ${result.failed} failed of ${urls.length}`);
		}

		// Report.
		if (rows.length === 0) {
			console.log(
				"\nMigration verified: counts match, no leftover WordPress URLs, no own-site Wayback " +
					"URLs left wrapped, every old URL answers 200.",
			);
		} else {
			console.log(`\n${rows.length} problems:`);
			for (const row of rows) {
				console.log(`  ${row.slug} — ${row.check}: ${row.found}${row.note ? ` (${row.note})` : ""}`);
			}
		}

		const blocking = rows.filter((row) => row.action !== "skipped");
		if (blocking.length > 0) process.exitCode = 1;
	} finally {
		await db.end();
	}
}

main().catch((error) => {
	console.error("verify-migration failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
