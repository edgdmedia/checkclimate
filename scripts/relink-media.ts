/**
 * relink-media.ts — rebuild the WordPress → R2 media map and repoint image
 * blocks the importer's URL rewrite missed.
 *
 * Why: the importer's media step dedupes byte-identical files by content hash.
 * When WordPress held two copies of one image (`john-kerry.webp` and
 * `john-kerry-1.webp`), only one media row is created and the urlMap the
 * admin returns is never saved to disk. Image blocks pointing at the other copy
 * keep their `wp-content` URL. This script:
 *
 *   1. lists every WordPress attachment through the EmDash Exporter
 *      (WP_MIGRATION_KEY in .env),
 *   2. matches each to a media row by filename, then by byte size + MIME type,
 *   3. writes migration/media-url-map.json (full URL and path keys → our media
 *      URL), which the redirects middleware and unwrap-wayback.ts read,
 *   4. rewrites `asset.url`/`asset._ref` of image blocks (top level and nested)
 *      in posts and pages whose URL is a bare (not Wayback-wrapped) upload URL.
 *
 *   pnpm tsx scripts/relink-media.ts --database=local          # dry run
 *   pnpm tsx scripts/relink-media.ts --database=local --apply  # write
 *
 * Idempotent: a second run finds nothing to relink.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connect, parseArgs } from "./lib/migration-db";

interface WpMedia {
	id: number;
	url: string;
	filename: string;
	mime_type: string;
	filesize: number;
}

const flags = parseArgs(process.argv.slice(2));
const MEDIA_PREFIX = "/_emdash/api/media/file/";
const UPLOAD_RE = /^https?:\/\/(?:www\.)?checkclimate\.africa(\/wp-content\/uploads\/[^?#]+)/;

function migrationAuth(): { base: string; header: string } {
	const env = readFileSync(".env", "utf8");
	const key = env.match(/^WP_MIGRATION_KEY=['"]?([^'"\n]+)/m)?.[1];
	if (!key) throw new Error("WP_MIGRATION_KEY missing from .env");
	const decoded = JSON.parse(Buffer.from(key.replace(/^em1\./, ""), "base64").toString()) as {
		url: string;
		user: string;
		pass: string;
	};
	return {
		base: decoded.url.replace(/\/$/, ""),
		header: "Basic " + Buffer.from(`${decoded.user}:${decoded.pass}`).toString("base64"),
	};
}

async function listWpMedia(): Promise<WpMedia[]> {
	const { base, header } = migrationAuth();
	const all: WpMedia[] = [];
	for (let page = 1; page < 50; page++) {
		const res = await fetch(`${base}/wp-json/emdash/v1/media?per_page=100&page=${page}`, {
			headers: { Authorization: header },
		});
		if (!res.ok) throw new Error(`exporter media page ${page}: HTTP ${res.status}`);
		const body = (await res.json()) as { items: WpMedia[]; pages: number };
		all.push(...body.items);
		if (page >= body.pages) break;
	}
	return all;
}

/** Strips a WordPress `-300x169` size suffix so a resized URL maps to its original. */
function unsized(path: string): string {
	return path.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1");
}

async function main() {
	const db = await connect(flags.branch);
	try {
		const wp = await listWpMedia();
		const { rows: media } = await db.query<{
			storage_key: string;
			filename: string;
			size: number;
			mime_type: string;
		}>("select storage_key, filename, size, mime_type from media");

		const byName = new Map<string, string>();
		const bySize = new Map<string, string>();
		for (const m of media) {
			if (!byName.has(m.filename)) byName.set(m.filename, m.storage_key);
			bySize.set(`${m.size}|${m.mime_type}`, m.storage_key);
		}

		// path (/wp-content/uploads/...) → media URL
		const pathMap = new Map<string, string>();
		const unmatched: string[] = [];
		for (const item of wp) {
			const path = item.url.match(UPLOAD_RE)?.[1];
			if (!path) continue;
			const key =
				byName.get(item.filename) ?? bySize.get(`${item.filesize}|${item.mime_type}`);
			if (key) pathMap.set(path, MEDIA_PREFIX + key);
			else unmatched.push(path);
		}

		const mapOut: Record<string, string> = {};
		for (const [path, target] of [...pathMap].sort()) {
			mapOut[path] = target;
			mapOut[`https://www.checkclimate.africa${path}`] = target;
			mapOut[`https://checkclimate.africa${path}`] = target;
		}

		// Same image, other spelling: WordPress `-scaled` originals and
		// re-encoded copies (`photo.jpg` served as `photo.avif`).
		const stem = (path: string) =>
			unsized(path)
				.replace(/\.(jpe?g|png|gif|webp|avif)$/i, "")
				.replace(/-scaled$/i, "")
				.replace(/\.(jpe?g|png|gif|webp|avif)$/i, "");
		const byStem = new Map<string, string>();
		for (const [path, target] of pathMap) if (!byStem.has(stem(path))) byStem.set(stem(path), target);

		const resolve = (url: string): string | null => {
			const path = url.match(UPLOAD_RE)?.[1];
			if (!path) return null;
			return pathMap.get(path) ?? pathMap.get(unsized(path)) ?? byStem.get(stem(path)) ?? null;
		};

		let blocks = 0;
		let unresolved = 0;
		const touched: string[] = [];
		for (const table of ["ec_posts", "ec_pages"]) {
			const { rows } = await db.query<{ id: string; slug: string; content: unknown }>(
				`select id, slug, content from ${table} where content::text like '%/wp-content/uploads/%'`,
			);
			for (const row of rows) {
				const content =
					typeof row.content === "string" ? JSON.parse(row.content) : row.content;
				let changed = false;
				const walk = (node: unknown): void => {
					if (Array.isArray(node)) return node.forEach(walk);
					if (!node || typeof node !== "object") return;
					const obj = node as Record<string, unknown>;
					const asset = obj.asset as Record<string, unknown> | undefined;
					if (obj._type === "image" && asset && typeof asset.url === "string") {
						const target = resolve(asset.url);
						if (target) {
							console.log(`[${flags.apply ? "fix" : "would fix"}] ${row.slug}: ${asset.url} → ${target}`);
							asset.url = target;
							asset._ref = target;
							changed = true;
							blocks++;
						} else if (UPLOAD_RE.test(asset.url)) {
							console.log(`[unresolved] ${row.slug}: ${asset.url}`);
							unresolved++;
						}
					}
					for (const value of Object.values(obj)) walk(value);
				};
				walk(content);
				if (changed) {
					touched.push(`${table}:${row.slug}`);
					if (flags.apply) {
						await db.query(`update ${table} set content = $1 where id = $2`, [
							JSON.stringify(content),
							row.id,
						]);
					}
				}
			}
		}

		if (flags.apply) {
			writeFileSync("migration/media-url-map.json", JSON.stringify(mapOut, null, "\t") + "\n");
		}
		console.log(
			`\nwp attachments ${wp.length}, mapped ${pathMap.size}, unmatched ${unmatched.length}` +
				`\nimage blocks ${flags.apply ? "relinked" : "to relink"} ${blocks} in ${touched.length} entries, unresolved ${unresolved}` +
				`\nmap ${flags.apply ? "written" : "not written (dry run)"}: migration/media-url-map.json (${Object.keys(mapOut).length} keys)`,
		);
		for (const path of unmatched) console.log(`[unmatched attachment] ${path}`);
	} finally {
		await db.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
