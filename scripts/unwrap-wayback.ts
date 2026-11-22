/**
 * unwrap-wayback.ts — unwrap Wayback Machine URLs whose original is on our own site.
 *
 * The WordPress site was partly restored from the Wayback Machine, so many URLs
 * in the imported content are wrapped as
 * `https://web.archive.org/web/<timestamp><flag>/<original>`. The site-owner
 * rule: only wrapped URLs whose original is on checkclimate.africa /
 * www.checkclimate.africa are processed. Every other Wayback URL is an
 * intentional archived citation (fact-check evidence) and is left exactly as
 * it is — reported as a KEPT count, one line each would bury the report.
 *
 * Own-site wrapped URLs are fixed like this:
 *   - links  → the root-relative path of the original (`/tag/<slug>/`, old
 *     `/yyyy/mm/dd/slug/` permalinks stay WordPress paths, which our routes keep)
 *   - images → the media-library copy in R2: from migration/media-url-map.json
 *     when the import's media step already brought it, otherwise the file is
 *     downloaded (live site first, then the Wayback `id_` raw copy) and
 *     uploaded through EmDash's media API so it gets a media row and an R2
 *     object. Never written to R2 directly.
 *
 * Run it from the repo, never on the Worker (it talks to the network and, for
 * uploads, to a local dev server):
 *
 *   pnpm tsx scripts/unwrap-wayback.ts                  # dry run, dev branch
 *   pnpm tsx scripts/unwrap-wayback.ts --database=prod  # against production data
 *   pnpm tsx scripts/unwrap-wayback.ts --apply          # write
 *   pnpm tsx scripts/unwrap-wayback.ts --slugs=a,b      # one or two rows
 *
 * With --apply, uploads need a local dev server (pnpm dev) so the media API
 * has somewhere to upload to; pass --media-url=<base> to point elsewhere.
 *
 * Idempotent: a second run finds nothing to change — except URLs in the
 * FAILED list, which are retried on every run (a failed download may have
 * been a network blip; nothing is written for them while they keep failing).
 *
 * Order in the migration: after the import's media step, before
 * post-import.ts and verify-migration.ts.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect, parseArgs, parseJson, wantsHelp } from "./lib/migration-db";
import {
	collectWaybackEdits,
	extractWrappedUrls,
	isImageOriginal,
	isOwnSiteOriginal,
	lookupMediaUrl,
	rewriteImageAsset,
	rootRelativePath,
	unwrapWayback,
	waybackRawUrl,
	type FieldOccurrence,
	type StringOccurrence,
} from "./lib/wayback";

const execFileAsync = promisify(execFile);

const USER_AGENT = "checkclimate-migration-unwrap";
const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";
/** Wayback throttling: at most one request per second. */
const THROTTLE_MS = 1000;

const HELP = `unwrap-wayback.ts

  --apply              write the rewrites and upload missing media (default: dry run)
  --database=<dev|prod>   Neon branch (default: dev)
  --slugs=a,b          only these slugs
  --map=<file>         media urlMap from the import's media step
                       (default: migration/media-url-map.json)
  --failed=<file>      where the FAILED list is written with --apply
                       (default: migration/unwrap-wayback-failed.json;
                       verify-migration.ts reads it)
  --media-url=<base>   EmDash instance the media uploads go to, via the
                       emdash CLI (default: http://localhost:4321)
  --help               this message
`;

interface PostRow {
	id: string;
	slug: string;
	title: string | null;
	content: unknown;
	featured_image: unknown;
}

/** A wrapped own-site URL that resolves to a Portable Text field. */
interface FieldEdit {
	occurrence: FieldOccurrence;
	/** Root-relative path (link) or media-library URL (image); null while pending. */
	replacement: string | null;
	source: "url-map" | "upload" | "pending";
}

/** A leftover-HTML field whose wrapped URLs are replaced inside the string. */
interface StringEdit {
	occurrence: StringOccurrence;
	/** Wrapped URL → replacement; null while the upload is pending. */
	replacements: Map<string, string | null>;
}

/** A wrapped own-site URL inside the featured_image column value. */
interface FeaturedEdit {
	row: PostRow;
	wrappedUrl: string;
	/** True when the column holds a bare URL string rather than an object. */
	isBareString: boolean;
	replacement: string | null;
	source: "url-map" | "upload" | "pending";
	alt?: string;
}

interface RowPlan {
	row: PostRow;
	table: "ec_posts" | "ec_pages";
	fields: FieldEdit[];
	strings: StringEdit[];
	featured: FeaturedEdit[];
	/** Own-site wrapped URLs left in place (upload failed), reported as FAILED. */
	failures: Array<{ kind: string; field: string; wrappedUrl: string; reason: string }>;
	external: number;
}

/** One unique original image that is not in the media urlMap yet. */
interface PendingUpload {
	original: string;
	unwrapped: NonNullable<ReturnType<typeof unwrapWayback>>;
	alts: string[];
}

function shorten(url: string, max = 96): string {
	return url.length <= max ? url : `${url.slice(0, max - 1)}…`;
}

/** Loads the media urlMap the importer's media step wrote. */
function loadUrlMap(file: string): Record<string, string> {
	try {
		const parsed = parseJson<Record<string, string>>(readFileSync(file, "utf8"), {});
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

// --- outbound downloads: throttled, with a retry on 429/5xx ----------------

let nextSlot = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spaces outbound requests at least one second apart. */
async function throttle(): Promise<void> {
	const now = Date.now();
	const wait = nextSlot - now;
	nextSlot = Math.max(nextSlot, now) + THROTTLE_MS;
	if (wait > 0) await sleep(wait);
}

type Download = {
	/** Raw image bytes, or null when the download did not produce an image. */
	bytes: Uint8Array | null;
	contentType: string;
	/** What happened, for the report ("HTTP 404", "HTTP 429", "ok"). */
	status: string;
};

async function fetchImage(url: string): Promise<Download> {
	let lastStatus = "unreachable";
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await throttle();
		try {
			const response = await fetch(url, {
				headers: { "user-agent": USER_AGENT, accept: "image/*,*/*" },
				redirect: "follow",
				signal: AbortSignal.timeout(60_000),
			});
			if (response.ok) {
				const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
				if (!contentType.startsWith("image/")) {
					return {
						bytes: null,
						contentType: "",
						status: `HTTP ${response.status} with ${contentType || "no type"}, not an image`,
					};
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.byteLength === 0) return { bytes: null, contentType: "", status: `HTTP ${response.status}, empty body` };
				return { bytes, contentType, status: `HTTP ${response.status}` };
			}
			lastStatus = `HTTP ${response.status}`;
			// 429/5xx may pass on the next try; anything else is final.
			if (response.status !== 429 && response.status < 500) return { bytes: null, contentType: "", status: lastStatus };
		} catch (error) {
			lastStatus = error instanceof Error ? error.message : "fetch failed";
		}
	}
	return { bytes: null, contentType: "", status: lastStatus };
}

// --- media upload through EmDash's media API, via the emdash CLI -----------

async function uploadMedia(
	cliPath: string,
	file: string,
	alt: string | undefined,
	mediaBase: string,
): Promise<{ id: string; storageKey: string }> {
	const args = ["media", "upload", file, "--json", "--url", mediaBase];
	if (alt) args.push("--alt", alt);
	const { stdout } = await execFileAsync(cliPath, args, {
		timeout: 180_000,
		maxBuffer: 10 * 1024 * 1024,
	});
	const item = JSON.parse(stdout) as { id?: string; storageKey?: string; url?: string };
	if (typeof item.storageKey === "string" && item.storageKey) {
		return { id: item.id ?? "", storageKey: item.storageKey };
	}
	if (typeof item.url === "string" && item.url.startsWith(INTERNAL_MEDIA_PREFIX)) {
		return { id: item.id ?? "", storageKey: item.url.slice(INTERNAL_MEDIA_PREFIX.length) };
	}
	throw new Error("the media API returned no storage key");
}

/** Extension for the temp file, so the upload gets the right MIME type. */
function extensionFor(original: string, contentType: string): string {
	try {
		const fromUrl = path.extname(new URL(original).pathname);
		if (fromUrl && fromUrl.length <= 6) return fromUrl;
	} catch {
		// Fall through to the content type.
	}
	const fromType = contentType.split("/")[1]?.split(";")[0];
	return fromType ? `.${fromType.replace(/[^a-z0-9]/gi, "")}` : ".img";
}

// --- the pass itself --------------------------------------------------------

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (wantsHelp(argv)) {
		console.log(HELP);
		return;
	}
	await run(parseFlags(argv));
}

interface Flags {
	dry: boolean;
	slugs: string[] | null;
	mapPath: string;
	failedPath: string;
	mediaBase: string;
	branch: "dev" | "prod" | "local";
}

function parseFlags(argv: string[]): Flags {
	const flags = parseArgs(argv);
	return {
		dry: !flags.apply,
		slugs: flags.slugs ? String(flags.slugs).split(",").map((s) => s.trim()).filter(Boolean) : null,
		mapPath: String(flags.map ?? "migration/media-url-map.json"),
		failedPath: String(flags.failed ?? "migration/unwrap-wayback-failed.json"),
		mediaBase: String(flags["media-url"] ?? "http://localhost:4321").replace(/\/+$/, ""),
		branch: flags.branch,
	};
}

/** Finds wrapped URLs in a featured_image column value (object or bare URL). */
function featuredCandidates(row: PostRow): Array<{ wrappedUrl: string; isBareString: boolean; alt?: string }> {
	const value = row.featured_image;
	if (typeof value === "string") {
		return unwrapWayback(value) ? [{ wrappedUrl: value, isBareString: true }] : [];
	}
	if (typeof value !== "object" || value === null) return [];
	const record = value as Record<string, unknown>;
	if (typeof record.src !== "string" || !unwrapWayback(record.src)) return [];
	return [
		{
			wrappedUrl: record.src,
			isBareString: false,
			alt: typeof record.alt === "string" ? record.alt : undefined,
		},
	];
}

/** Writes the resolved media URL back into a featured_image column value. */
function applyFeaturedReplacement(edit: FeaturedEdit): void {
	if (edit.isBareString) {
		edit.row.featured_image = edit.replacement;
		return;
	}
	const record = edit.row.featured_image as Record<string, unknown>;
	record.src = edit.replacement;
	if (typeof record.provider === "string" && record.provider !== "local") delete record.provider;
	if (typeof edit.replacement === "string" && edit.replacement.startsWith(INTERNAL_MEDIA_PREFIX)) {
		const meta = typeof record.meta === "object" && record.meta !== null ? record.meta : {};
		record.meta = {
			...(meta as Record<string, unknown>),
			storageKey: edit.replacement.slice(INTERNAL_MEDIA_PREFIX.length),
		};
	}
}

async function run(flags: Flags): Promise<void> {
	const { dry, slugs, mediaBase } = flags;
	const urlMap = loadUrlMap(flags.mapPath);
	if (Object.keys(urlMap).length === 0) {
		console.log(
			"migration/media-url-map.json is empty or missing: every own-site wrapped image will be " +
				"downloaded and uploaded through the media API.",
		);
	}

	const cliPath = fileURLToPath(new URL("../node_modules/.bin/emdash", import.meta.url));
	const db = await connect(flags.branch);

	try {
		const plans: RowPlan[] = [];
		const queue = new Map<string, PendingUpload>();

		const queueImage = (
			_unwrapped: NonNullable<ReturnType<typeof unwrapWayback>>,
			alt: string | undefined,
		): void => {
			const pending = queue.get(_unwrapped.original) ?? {
				original: _unwrapped.original,
				unwrapped: _unwrapped,
				alts: [],
			};
			if (alt && !pending.alts.includes(alt)) pending.alts.push(alt);
			queue.set(_unwrapped.original, pending);
		};

		// 1. Collect every wrapped URL in every row, and what each needs.
		for (const table of ["ec_posts", "ec_pages"] as const) {
			const result = await db.query(
				`select id, slug, title, content, featured_image from ${table}
				 where deleted_at is null order by slug limit $1`,
				[5000],
			);
			for (const raw of result.rows as PostRow[]) {
				if (slugs && !slugs.includes(raw.slug)) continue;
				const plan: RowPlan = {
					row: raw,
					table,
					fields: [],
					strings: [],
					featured: [],
					failures: [],
					external: 0,
				};

				const { fields, strings } = collectWaybackEdits(raw.content);

				for (const occurrence of fields) {
					const unwrapped = unwrapWayback(occurrence.wrappedUrl);
					if (!unwrapped) continue;
					if (!isOwnSiteOriginal(unwrapped.original)) {
						plan.external += 1;
						continue;
					}
					if (occurrence.kind === "image") {
						const mapped = lookupMediaUrl(urlMap, unwrapped.original);
						if (mapped) {
							plan.fields.push({ occurrence, replacement: mapped, source: "url-map" });
						} else {
							queueImage(unwrapped, occurrence.alt);
							plan.fields.push({ occurrence, replacement: null, source: "pending" });
						}
					} else {
						plan.fields.push({ occurrence, replacement: rootRelativePath(unwrapped.original), source: "url-map" });
					}
				}

				for (const occurrence of strings) {
					const replacements = new Map<string, string | null>();
					for (const wrapped of extractWrappedUrls(occurrence.html)) {
						const unwrapped = unwrapWayback(wrapped);
						if (!unwrapped) continue;
						if (!isOwnSiteOriginal(unwrapped.original)) {
							plan.external += 1;
							continue;
						}
						if (isImageOriginal(unwrapped.original)) {
							const mapped = lookupMediaUrl(urlMap, unwrapped.original);
							if (mapped) {
								replacements.set(wrapped, mapped);
							} else {
								queueImage(unwrapped, undefined);
								replacements.set(wrapped, null);
							}
						} else {
							replacements.set(wrapped, rootRelativePath(unwrapped.original));
						}
					}
					if (replacements.size > 0) plan.strings.push({ occurrence, replacements });
				}

				for (const candidate of featuredCandidates(raw)) {
					const unwrapped = unwrapWayback(candidate.wrappedUrl);
					if (!unwrapped) continue;
					if (!isOwnSiteOriginal(unwrapped.original)) {
						plan.external += 1;
						continue;
					}
					const edit: FeaturedEdit = {
						row: raw,
						wrappedUrl: candidate.wrappedUrl,
						isBareString: candidate.isBareString,
						replacement: null,
						source: "pending",
						alt: candidate.alt,
					};
					const mapped = lookupMediaUrl(urlMap, unwrapped.original);
					if (mapped) {
						edit.replacement = mapped;
						edit.source = "url-map";
					} else {
						queueImage(unwrapped, candidate.alt);
					}
					plan.featured.push(edit);
				}

				plans.push(plan);
			}
		}

		if (plans.length === 0) {
			console.log(
				`No posts or pages found on the ${flags.branch} branch` +
					(slugs ? ` for slugs ${slugs.join(", ")}` : "") +
					". Run the WordPress import first.",
			);
			return;
		}

		// 2. Resolve pending uploads — one download+upload per unique original.
		let uploaded = 0;
		const scratch = mkdtempSync(path.join(tmpdir(), "unwrap-wayback-"));
		try {
			let index = 0;
			for (const pending of queue.values()) {
				index += 1;
				if (dry) continue;
				let downloaded = await fetchImage(pending.original);
				let via = "the live site";
				if (!downloaded.bytes) {
					const liveStatus = downloaded.status;
					downloaded = await fetchImage(waybackRawUrl(pending.unwrapped));
					via = "the Wayback raw copy";
					if (!downloaded.bytes) {
						markFailed(plans, pending.original, `live: ${liveStatus}; Wayback: ${downloaded.status}`);
						continue;
					}
				}
				const file = path.join(scratch, `img-${index}${extensionFor(pending.original, downloaded.contentType)}`);
				writeFileSync(file, downloaded.bytes);
				try {
					const media = await uploadMedia(cliPath, file, pending.alts[0], mediaBase);
					const mediaUrl = `${INTERNAL_MEDIA_PREFIX}${media.storageKey}`;
					urlMap[pending.original] = mediaUrl;
					resolveUploads(plans, pending.original, mediaUrl);
					uploaded += 1;
					console.error(`[upload] ${shorten(pending.original, 72)} → ${mediaUrl} (${via})`);
				} catch (error) {
					const message = error instanceof Error ? error.message.split("\n")[0] : "upload failed";
					markFailed(plans, pending.original, `downloaded OK but upload failed (${via}): ${message}`);
				} finally {
					rmSync(file, { force: true });
				}
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}

		// 3. Apply the edits and report, one line per URL.
		let changedRows = 0;
		let ownSiteCount = 0;
		let failedCount = 0;
		const failureList: Array<{ slug: string; kind: string; field: string; url: string; reason: string }> = [];

		for (const plan of plans) {
			let rowChanged = false;
			const count = (): void => {
				ownSiteCount += 1;
			};

			for (const edit of plan.fields) {
				const unwrapped = unwrapWayback(edit.occurrence.wrappedUrl);
				if (!unwrapped || !isOwnSiteOriginal(unwrapped.original)) continue;
				count();
				if (edit.replacement === null) {
					// Dry run: nothing has been resolved yet. In an apply run a
					// null replacement means the upload failed; plan.failures
					// already carries the FAILED line.
					if (dry) {
						console.log(
							`[would upload] ${plan.row.slug} — ${edit.occurrence.kind} — ${edit.occurrence.field}: ` +
								`${shorten(edit.occurrence.wrappedUrl)} → media library (from ${shorten(unwrapped.original, 72)})`,
						);
						rowChanged = true;
					}
					continue;
				}
				const note = edit.source === "upload" ? "uploaded to the media library" : "media-url-map";
				if (dry) {
					console.log(
						`[would fix] ${plan.row.slug} — ${edit.occurrence.kind} — ${edit.occurrence.field}: ` +
							`${shorten(edit.occurrence.wrappedUrl)} → ${edit.replacement} (${note})`,
					);
				} else {
					if (edit.occurrence.kind === "image" && edit.occurrence.block) {
						rewriteImageAsset(edit.occurrence.block, edit.replacement);
					} else {
						edit.occurrence.container[edit.occurrence.key] = edit.replacement;
					}
					console.log(
						`[fixed] ${plan.row.slug} — ${edit.occurrence.kind} — ${edit.occurrence.field}: ` +
							`${shorten(edit.occurrence.wrappedUrl)} → ${edit.replacement} (${note})`,
					);
					rowChanged = true;
				}
			}

			for (const stringEdit of plan.strings) {
				let current: string | null = null;
				for (const [wrapped, replacement] of stringEdit.replacements) {
					const unwrapped = unwrapWayback(wrapped);
					if (!unwrapped || !isOwnSiteOriginal(unwrapped.original)) continue;
					count();
					if (replacement === null) {
						if (dry) {
							console.log(
								`[would upload] ${plan.row.slug} — html — ${stringEdit.occurrence.field}: ` +
									`${shorten(wrapped)} → media library (from ${shorten(unwrapped.original, 72)})`,
							);
							rowChanged = true;
						}
						continue;
					}
					if (dry) {
						console.log(
							`[would fix] ${plan.row.slug} — html — ${stringEdit.occurrence.field}: ` +
								`${shorten(wrapped)} → ${replacement}`,
						);
					} else {
						if (current === null) current = stringEdit.occurrence.container[stringEdit.occurrence.key] as string;
						current = current.split(wrapped).join(replacement);
						console.log(
							`[fixed] ${plan.row.slug} — html — ${stringEdit.occurrence.field}: ` +
								`${shorten(wrapped)} → ${replacement}`,
						);
						rowChanged = true;
					}
				}
				if (!dry && current !== null) {
					stringEdit.occurrence.container[stringEdit.occurrence.key] = current;
				}
			}

			for (const edit of plan.featured) {
				const unwrapped = unwrapWayback(edit.wrappedUrl);
				if (!unwrapped || !isOwnSiteOriginal(unwrapped.original)) continue;
				count();
				if (edit.replacement === null) {
					if (dry) {
						console.log(
							`[would upload] ${plan.row.slug} — image — featured_image: ` +
								`${shorten(edit.wrappedUrl)} → media library (from ${shorten(unwrapped.original, 72)})`,
						);
						rowChanged = true;
					}
					continue;
				}
				const note = edit.source === "upload" ? "uploaded to the media library" : "media-url-map";
				if (dry) {
					console.log(
						`[would fix] ${plan.row.slug} — image — featured_image: ` +
							`${shorten(edit.wrappedUrl)} → ${edit.replacement} (${note})`,
					);
				} else {
					applyFeaturedReplacement(edit);
					console.log(
						`[fixed] ${plan.row.slug} — image — featured_image: ` +
							`${shorten(edit.wrappedUrl)} → ${edit.replacement} (${note})`,
					);
					rowChanged = true;
				}
			}

			// Failures: the URL stays exactly as it is; the image is not dropped.
			for (const failure of plan.failures) {
				failedCount += 1;
				console.log(
					`[FAILED] ${plan.row.slug} — ${failure.kind} — ${failure.field}: ` +
						`${shorten(failure.wrappedUrl)} → left as is (${failure.reason})`,
				);
				failureList.push({
					slug: plan.row.slug,
					kind: failure.kind,
					field: failure.field,
					url: failure.wrappedUrl,
					reason: failure.reason,
				});
			}

			if (rowChanged && !dry) {
				const content = JSON.stringify(plan.row.content);
				if (plan.featured.length > 0) {
					await db.query(`update ${plan.table} set content = $1::jsonb, featured_image = $2::jsonb where id = $3`, [
						content,
						JSON.stringify(plan.row.featured_image),
						plan.row.id,
					]);
				} else {
					await db.query(`update ${plan.table} set content = $1::jsonb where id = $2`, [content, plan.row.id]);
				}
				changedRows += 1;
			}
		}

		// 4. Summary.
		const externalCount = plans.reduce((sum, plan) => sum + plan.external, 0);
		const externalRows = plans.filter((plan) => plan.external > 0).length;
		console.log(
			`\nKEPT: ${externalCount} external Wayback citations in ${externalRows} rows — archived ` +
				"sources, left exactly as they are.",
		);
		const touchedRows = new Set(
			plans
				.filter((plan) => plan.fields.length + plan.strings.length + plan.featured.length + plan.failures.length > 0)
				.map((plan) => plan.row.slug),
		);
		const pendingCount = queue.size;
		console.log(
			`${ownSiteCount} own-site wrapped URLs in ${touchedRows.size} rows` +
				(dry
					? pendingCount > 0
						? `: ${pendingCount} unique image(s) need the media library.`
						: "."
					: `: rewritten across ${changedRows} rows.`),
		);
		if (!dry && uploaded > 0) console.log(`${uploaded} new media items uploaded through the media API.`);
		if (dry && pendingCount > 0) {
			console.log(
				`${queue.size} unique image(s) would be downloaded and uploaded — with --apply this needs a ` +
					`local dev server (pnpm dev) for the media API at ${mediaBase}.`,
			);
		}
		if (!dry) {
			writeFileSync(flags.mapPath, `${JSON.stringify(urlMap, null, "\t")}\n`);
			console.log(`media urlMap updated (${Object.keys(urlMap).length} entries in ${flags.mapPath}).`);
			writeFileSync(flags.failedPath, `${JSON.stringify(failureList, null, "\t")}\n`);
			console.log(
				failedCount > 0
					? `FAILED list written to ${flags.failedPath}; verify-migration will not block on these ` +
							"until they are fixed, and every run retries them."
					: `FAILED list is empty; ${flags.failedPath} written anyway so a stale list cannot mask anything.`,
			);
		}
	} finally {
		await db.end();
	}
}

/** Marks every edit waiting on an original as failed (the download or upload died). */
function markFailed(plans: RowPlan[], original: string, reason: string): void {
	for (const plan of plans) {
		for (const edit of plan.fields) {
			const unwrapped = unwrapWayback(edit.occurrence.wrappedUrl);
			if (!unwrapped || unwrapped.original !== original) continue;
			edit.replacement = null;
			edit.source = "pending";
			plan.failures.push({
				kind: edit.occurrence.kind,
				field: edit.occurrence.field,
				wrappedUrl: edit.occurrence.wrappedUrl,
				reason,
			});
		}
		for (const stringEdit of plan.strings) {
			for (const [wrapped, replacement] of stringEdit.replacements) {
				if (replacement !== null) continue;
				const unwrapped = unwrapWayback(wrapped);
				if (!unwrapped || unwrapped.original !== original) continue;
				plan.failures.push({ kind: "html", field: stringEdit.occurrence.field, wrappedUrl: wrapped, reason });
			}
		}
		for (const edit of plan.featured) {
			const unwrapped = unwrapWayback(edit.wrappedUrl);
			if (!unwrapped || unwrapped.original !== original) continue;
			edit.replacement = null;
			edit.source = "pending";
			plan.failures.push({ kind: "image", field: "featured_image", wrappedUrl: edit.wrappedUrl, reason });
		}
	}
}

/** Fills in the resolved media URL for every edit waiting on an original. */
function resolveUploads(plans: RowPlan[], original: string, mediaUrl: string): void {
	for (const plan of plans) {
		for (const edit of plan.fields) {
			const unwrapped = unwrapWayback(edit.occurrence.wrappedUrl);
			if (!unwrapped || unwrapped.original !== original) continue;
			edit.replacement = mediaUrl;
			edit.source = "upload";
		}
		for (const stringEdit of plan.strings) {
			for (const [wrapped, replacement] of stringEdit.replacements) {
				if (replacement !== null) continue;
				const unwrapped = unwrapWayback(wrapped);
				if (!unwrapped || unwrapped.original !== original) continue;
				stringEdit.replacements.set(wrapped, mediaUrl);
			}
		}
		for (const edit of plan.featured) {
			const unwrapped = unwrapWayback(edit.wrappedUrl);
			if (!unwrapped || unwrapped.original !== original) continue;
			edit.replacement = mediaUrl;
			edit.source = "upload";
		}
	}
}

main().catch((error) => {
	console.error("unwrap-wayback failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
