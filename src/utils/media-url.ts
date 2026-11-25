/**
 * Image URLs on the media bucket's own domain, resized at Cloudflare's edge.
 *
 * With MEDIA_PUBLIC_URL set (https://media.checkclimate.africa), an image
 * stored at `<key>` is linked as
 *
 *   <base>/<key>                                 the original
 *   <base>/cdn-cgi/image/<options>/<key>         a resized WebP
 *
 * so neither the bytes nor the resizing pass through this process. EmDash's
 * components are still the ones that render: they get one of these URLs as
 * the image's `src`. The media host is not an Astro image domain, so EmDash
 * renders a plain <img> with its usual markup instead of a `/_image` URL.
 *
 * Transformations are counted per unique URL a month (5,000 free per account,
 * shared with every site on it), so each place an image appears asks for one
 * fixed size, in a fixed option order. `fit=crop` never enlarges: the
 * originals are ~700px wide, and CSS `object-fit` does the visual crop.
 * `onerror=redirect` serves the original if a transformation fails or the
 * monthly allowance runs out.
 *
 * Without MEDIA_PUBLIC_URL every function returns null and callers keep the
 * value they had, so laptop, CI and the box before the switch are unchanged.
 */
import { runtime } from "../runtime";

/** EmDash's media route; imported content stores image URLs in this form. */
const MEDIA_PATH = "/_emdash/api/media/file/";

/** Storage key behind a media value, a media-route URL or a bare key. */
export function storageKeyOf(value: unknown): string | null {
	if (typeof value === "string") return keyFromUrl(value);
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const meta = record.meta as Record<string, unknown> | undefined;
	if (typeof meta?.storageKey === "string" && meta.storageKey) return meta.storageKey;
	if (typeof record.src === "string") return keyFromUrl(record.src);
	return null;
}

function keyFromUrl(url: string): string | null {
	let path = url;
	if (/^https?:\/\//i.test(url)) {
		try {
			const parsed = new URL(url);
			// Only this site's own media route; an external image stays external.
			if (parsed.hostname !== new URL(runtime.siteUrl).hostname) return null;
			path = parsed.pathname;
		} catch {
			return null;
		}
	}
	if (!path.startsWith(MEDIA_PATH)) return null;
	const key = path.slice(MEDIA_PATH.length).split("?")[0] ?? "";
	try {
		return key ? decodeURIComponent(key) : null;
	} catch {
		return null;
	}
}

const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

/** The original file on the media domain, or null when there is none. */
export function publicMediaUrl(value: unknown, base = runtime.mediaPublicUrl): string | null {
	const key = storageKeyOf(value);
	return base && key ? `${base}/${encodeKey(key)}` : null;
}

export interface EdgeSize {
	width: number;
	height?: number;
	/** `crop` fills width×height without enlarging; `scale-down` fits inside. */
	fit?: "crop" | "scale-down";
}

/**
 * Originals Cloudflare cannot resize: AVIF input fails (`cf-resized: err=9520`)
 * and SVG/GIF are passed through. Linking the original directly skips a
 * failed transformation and the extra redirect `onerror` would cost.
 */
const NOT_RESIZABLE = /\.(avif|svg|gif)$/i;

/** A resized WebP from Cloudflare's edge, or null when there is none. */
export function edgeImageUrl(value: unknown, size: EdgeSize, base = runtime.mediaPublicUrl): string | null {
	const key = storageKeyOf(value);
	if (!base || !key) return null;
	if (NOT_RESIZABLE.test(key)) return `${base}/${encodeKey(key)}`;
	const options = [
		`width=${Math.round(size.width)}`,
		size.height ? `height=${Math.round(size.height)}` : null,
		`fit=${size.fit ?? (size.height ? "crop" : "scale-down")}`,
		"format=webp",
		// The default (85) made some already-small JPEG originals bigger as
		// WebP; 75 came out smaller than the original on every sampled image.
		"quality=75",
		"onerror=redirect",
	]
		.filter(Boolean)
		.join(",");
	return `${base}/cdn-cgi/image/${options}/${encodeKey(key)}`;
}

/**
 * A copy of a media value whose `src` is the edge-resized URL, for EmDash's
 * <Image>. Anything else on the value (alt, dimensions) is kept; the value is
 * returned unchanged when there is no media domain or no storage key.
 */
export function withEdgeSource<T>(value: T, size: EdgeSize): T {
	const src = edgeImageUrl(value, size);
	if (!src || !value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return { ...record, provider: "external", id: typeof record.id === "string" ? record.id : "", src, meta: undefined } as T;
}
