/**
 * Wayback Machine URL helpers, shared by the migration scripts.
 *
 * The WordPress site was partly restored from the Wayback Machine, so many
 * URLs inside the imported content are wrapped as
 *
 *   https://web.archive.org/web/<14-digit timestamp><flag>/<original URL>
 *
 * where <flag> is empty or one of `id_`, `im_`, `if_`, `js_`, `cs_`, and the
 * original is sometimes written as `https:/host` with a single slash. A
 * wrapped URL can wrap another Wayback URL. An original on archive.ph /
 * archive.today is a deliberate citation, not a wrapper, and is returned
 * untouched (only `web.archive.org` layers are unwrapped).
 *
 * Site-owner rule: only Wayback URLs whose original is on our own site
 * (`checkclimate.africa` / `www.checkclimate.africa`) are processed. Every
 * other Wayback URL is an intentional archived citation and stays as it is.
 */

const WAYBACK_HOST = "web.archive.org";

/** `<flag>` values the Wayback Machine uses after the timestamp. */
const FLAGS = ["id_", "im_", "if_", "js_", "cs_"] as const;

const FLAG_GROUP = `(?:${FLAGS.map((flag) => flag.replace("_", "_")).join("|")})?`;

/** `/web/<14 digits><optional flag>/<original>` — strict, no trailing junk. */
const WAYBACK_PATH = new RegExp(`^/web/(\\d{14})(?!\\d)(${FLAG_GROUP})/(.+)$`);

/** Hosts the migration treats as "ours". */
export const OWN_HOSTS: ReadonlySet<string> = new Set([
	"checkclimate.africa",
	"www.checkclimate.africa",
]);

/** Matches a wrapped URL inside free text (HTML blocks), without trailing prose punctuation. */
export const WAYBACK_URL_IN_HTML =
	/https?:\/\/web\.archive\.org\/web\/\d{14}(?:id_|im_|if_|js_|cs_)?\/[^\s"'<>]+/g;

export interface UnwrappedWayback {
	/** The URL the wrapper points at, fully unwrapped. */
	original: string;
	/** Timestamp of the innermost (most specific) wrapper. */
	timestamp: string;
	/** Capture flag of the innermost wrapper, or "" when it had none. */
	flag: string;
}

/** `https:/host` → `https://host`, leaving a proper URL alone. */
function normaliseScheme(url: string): string {
	return url
		.replace(/^https:\/(?!\/)/i, "https://")
		.replace(/^http:\/(?!\/)/i, "http://")
		.replace(/^https:(?!\/\/)/i, "https://")
		.replace(/^http:(?!\/\/)/i, "http://");
}

function parseOneWrapper(url: string): { original: string; timestamp: string; flag: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.hostname.toLowerCase() !== WAYBACK_HOST) return null;
	if (!parsed.pathname.startsWith("/web/")) return null;
	// The original may contain encoded characters; match on the raw path so
	// nothing is re-encoded. The query string belongs to the original.
	const match = WAYBACK_PATH.exec(parsed.pathname);
	if (!match) return null;
	return {
		timestamp: match[1]!,
		flag: match[2] ?? "",
		original: normaliseScheme(match[3]!) + (parsed.search || ""),
	};
}

/**
 * Unwraps a Wayback Machine URL, repeatedly, until the value is no longer a
 * Wayback wrapper. Returns `null` for anything that is not wrapped.
 */
export function unwrapWayback(url: string): UnwrappedWayback | null {
	let current = url.trim();
	const first = parseOneWrapper(current);
	if (!first) return null;

	let timestamp = first.timestamp;
	let flag = first.flag;
	let original = first.original;
	// A wrapped URL can wrap another Wayback URL; keep going until it stops.
	for (let depth = 0; depth < 8; depth += 1) {
		const next = parseOneWrapper(original);
		if (!next) break;
		timestamp = next.timestamp;
		flag = next.flag;
		original = next.original;
	}
	return { original, timestamp, flag };
}

/** The raw-bytes URL for a snapshot: the `id_` flag skips the Wayback toolbar. */
export function waybackRawUrl(unwrapped: UnwrappedWayback): string {
	return `https://${WAYBACK_HOST}/web/${unwrapped.timestamp}id_/${unwrapped.original}`;
}

/** The wrapped URL's original when it points at our own site, else `null`. */
export function isOwnSiteOriginal(original: string): URL | null {
	let parsed: URL | null = null;
	try {
		parsed = new URL(original);
	} catch {
		// A wrapper can leave the scheme off entirely; try https before giving up.
		try {
			parsed = new URL(`https://${original}`);
		} catch {
			return null;
		}
	}
	return OWN_HOSTS.has(parsed.hostname.toLowerCase()) ? parsed : null;
}

/** Root-relative path (with query and fragment) for our own WordPress routes. */
export function rootRelativePath(original: string): string {
	const parsed = isOwnSiteOriginal(original);
	if (!parsed) return original;
	const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
	return path === "" ? "/" : path;
}

/** File extensions that make an original an image rather than a page link. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)$/i;

/** Whether an original URL points at a media file (uploads or an image extension). */
export function isImageOriginal(original: string): boolean {
	const parsed = isOwnSiteOriginal(original);
	if (!parsed) return false;
	return parsed.pathname.startsWith("/wp-content/uploads/") || IMAGE_EXTENSIONS.test(parsed.pathname);
}

/** URL without its query string and fragment, for base matching. */
export function getBaseUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.split("?")[0] ?? url;
	}
}

/** Strips the `-300x169` style size suffix WordPress appends to image variants. */
export function stripWordPressImageSizeSuffix(base: string): string {
	return base.replace(/-\d+x\d+(?=\.[^./?#]+$)/, "");
}

/** The same URL with the other host spelling and the other scheme. */
export function hostVariants(url: string): string[] {
	const variants = [url];
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return variants;
	}
	for (const host of [...OWN_HOSTS]) {
		for (const scheme of ["https", "http"]) {
			const variant = `${scheme}://${host}${parsed.pathname}${parsed.search}`;
			if (!variants.includes(variant)) variants.push(variant);
		}
	}
	return variants;
}

/** Whether a URL-map key carries a query string: matched exactly, never by base. */
function carriesQuery(url: string): boolean {
	return url.includes("?");
}

/**
 * Finds the R2 media-library URL for an original WordPress image, the way the
 * importer's media step matches: exact URL, then base (no query), then the
 * full-size original behind a `-300x169` size variant — each also tried on the
 * other host spelling and scheme, because the content mixes www/apex/http.
 * Map keys that carry a query match by base only.
 */
export function lookupMediaUrl(urlMap: Record<string, string>, original: string): string | null {
	const variants = hostVariants(original);
	for (const candidate of variants) {
		if (urlMap[candidate]) return urlMap[candidate]!;
		const base = getBaseUrl(candidate);
		if (urlMap[base]) return urlMap[base]!;
		const sized = stripWordPressImageSizeSuffix(base);
		if (sized !== base && urlMap[sized]) return urlMap[sized]!;
	}
	// A map key with a query (`.../full.jpg?w=9`) is matched by its base.
	for (const [key, value] of Object.entries(urlMap)) {
		if (!carriesQuery(key)) continue;
		const keyBase = getBaseUrl(key);
		for (const candidate of variants) {
			const base = getBaseUrl(candidate);
			if (keyBase === base || keyBase === stripWordPressImageSizeSuffix(base)) return value;
		}
	}
	return null;
}

export interface FieldOccurrence {
	/** Object holding the field; applying an edit sets `container[key]`. */
	container: Record<string, unknown>;
	key: string;
	/** Human-readable field path for the report, e.g. `markDefs[k1].href`. */
	field: string;
	/** `image` fields resolve to a media-library item; `link` fields to a path. */
	kind: "image" | "link";
	/** The wrapped URL exactly as it appears in the content. */
	wrappedUrl: string;
	/** The owning image block, when the field lives on one (for dropping `srcset`). */
	block?: Record<string, unknown>;
	/** Alt text from the surrounding block, for the media upload. */
	alt?: string;
}

export interface StringOccurrence {
	container: Record<string, unknown>;
	key: string;
	/** Human-readable field path, e.g. `htmlBlock.html`. */
	field: string;
	html: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushIfWrapped(
	fields: FieldOccurrence[],
	container: Record<string, unknown>,
	key: string,
	field: string,
	kind: "image" | "link",
	extra?: Partial<FieldOccurrence>,
): void {
	const value = container[key];
	if (typeof value !== "string" || !unwrapWayback(value)) return;
	fields.push({ container, key, field, kind, wrappedUrl: value, ...extra });
}

/** Collects the markDefs link definitions of one block. */
function collectMarkDefs(
	fields: FieldOccurrence[],
	markDefs: unknown,
	label: (def: Record<string, unknown>, index: number) => string,
): void {
	if (!Array.isArray(markDefs)) return;
	markDefs.forEach((def, index) => {
		if (!isRecord(def)) return;
		pushIfWrapped(fields, def, "href", `${label(def, index)}.href`, "link");
	});
}

/** Recursively walks a Portable Text array collecting every wrapped URL. */
export function collectWaybackEdits(blocks: unknown): {
	fields: FieldOccurrence[];
	strings: StringOccurrence[];
} {
	const fields: FieldOccurrence[] = [];
	const strings: StringOccurrence[] = [];

	const walk = (value: unknown): void => {
		if (!Array.isArray(value)) return;
		for (const entry of value) {
			if (!isRecord(entry)) continue;
			switch (String(entry._type ?? "")) {
				case "image": {
					const asset = isRecord(entry.asset) ? entry.asset : undefined;
					if (asset) {
						for (const key of ["url", "_ref"]) {
							pushIfWrapped(fields, asset, key, `asset.${key}`, "image", {
								block: entry,
								alt: typeof entry.alt === "string" ? entry.alt : undefined,
							});
						}
					}
					// A linked image: legacy bare string, or `{ href, blank? }`.
					if (typeof entry.link === "string") {
						pushIfWrapped(fields, entry, "link", "link", "link", {
							alt: typeof entry.alt === "string" ? entry.alt : undefined,
						});
					} else if (isRecord(entry.link)) {
						pushIfWrapped(fields, entry.link, "href", "link.href", "link", {
							alt: typeof entry.alt === "string" ? entry.alt : undefined,
						});
					}
					break;
				}
				case "gallery":
					walk(entry.images);
					break;
				case "columns":
					for (const column of Array.isArray(entry.columns) ? entry.columns : []) {
						if (isRecord(column)) walk(column.content);
					}
					break;
				case "cover":
					pushIfWrapped(fields, entry, "backgroundImage", "backgroundImage", "image");
					walk(entry.content);
					break;
				case "block":
					collectMarkDefs(fields, entry.markDefs, (def, index) => `markDefs[${def._key ?? index}]`);
					break;
				case "table":
					for (const row of Array.isArray(entry.rows) ? entry.rows : []) {
						if (!isRecord(row) || !Array.isArray(row.cells)) continue;
						for (const cell of row.cells) {
							if (isRecord(cell)) collectMarkDefs(fields, cell.markDefs, (def, index) => `markDefs[${def._key ?? index}]`);
						}
					}
					break;
				case "file":
					pushIfWrapped(fields, entry, "url", "url", "image");
					break;
				case "button":
					pushIfWrapped(fields, entry, "url", "url", "link");
					break;
				case "buttons":
					for (const button of Array.isArray(entry.buttons) ? entry.buttons : []) {
						if (isRecord(button)) pushIfWrapped(fields, button, "url", "buttons[].url", "link");
					}
					break;
				case "embed":
					pushIfWrapped(fields, entry, "url", "url", "link");
					for (const key of ["html", "value"]) {
						if (typeof entry[key] === "string" && extractWrappedUrls(entry[key] as string).length > 0) {
							strings.push({ container: entry, key, field: key, html: entry[key] as string });
						}
					}
					break;
				case "htmlBlock":
					for (const key of ["html", "value"]) {
						if (typeof entry[key] === "string" && extractWrappedUrls(entry[key] as string).length > 0) {
							strings.push({ container: entry, key, field: key, html: entry[key] as string });
						}
					}
					break;
				case "video":
				case "iframe":
					for (const key of ["src", "url", "source"]) {
						pushIfWrapped(fields, entry, key, key, "link");
					}
					break;
				default:
					break;
			}
		}
	};

	walk(blocks);
	return { fields, strings };
}

/** Every wrapped URL in a string (HTML block), deduplicated, in order. */
export function extractWrappedUrls(html: string): string[] {
	const matches = html.match(WAYBACK_URL_IN_HTML) ?? [];
	// Trailing punctuation from prose; attribute values are already clean.
	return [...new Set(matches.map((url) => url.replace(/[),.;:!]+$/, "")))];
}

/**
 * Rewrites an image block to reference the media-library item, exactly the
 * way the importer's media step does (`asset.url` and `asset._ref` set to the
 * internal media URL), plus `asset.meta.storageKey` for the Image component.
 * Drops any `srcset` on the block: the media copy is the one true file.
 */
export function rewriteImageAsset(block: Record<string, unknown>, mediaUrl: string): void {
	const asset = isRecord(block.asset) ? block.asset : {};
	const meta = isRecord(asset.meta) ? asset.meta : {};
	const storageKey = mediaUrl.startsWith("/_emdash/api/media/file/")
		? mediaUrl.slice("/_emdash/api/media/file/".length)
		: "";
	asset.url = mediaUrl;
	asset._ref = mediaUrl;
	if (storageKey) asset.meta = { ...meta, storageKey };
	block.asset = asset;
	if (typeof block.srcset === "string") delete block.srcset;
}
