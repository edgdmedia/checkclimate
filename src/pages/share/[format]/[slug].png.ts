/**
 * Fact-check share card: /share/wide/<slug>.png (1200×630, the link preview)
 * and /share/portrait/<slug>.png (1080×1350, Instagram / WhatsApp Status).
 * Add ?download to get it as an attachment.
 *
 * Drawn from the post's claim and verdict fields (layout:
 * src/utils/share-card.ts, painter: src/utils/share-render.ts) over the post
 * photo, heavily faded under a green shade. Each render is stored in the media
 * bucket under a key that hashes everything drawn, so an edit to the post
 * makes a new card and repeat requests never re-render.
 */
import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";
import type { Post } from "../../../utils/content";
import { imageUrl, isFactCheck } from "../../../utils/content";
import { getObject, putObject } from "../../../utils/media-store";
import { shareLayout, type ShareFormat } from "../../../utils/share-card";
import { renderCard } from "../../../utils/share-render";

/** Bump when the design changes, so stored cards are redrawn. */
const DESIGN_VERSION = "3";
const BRAND_HOST = "checkclimate.africa";
const MEDIA_PREFIX = "/_emdash/api/media/file/";

function isFormat(value: string | undefined): value is ShareFormat {
	return value === "wide" || value === "portrait";
}

async function sha(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The post photo as bytes: straight from the bucket for media-library files. */
async function photoBytes(origin: string, image: unknown): Promise<Buffer | null> {
	const url = imageUrl(origin, image);
	if (!url) return null;
	try {
		const parsed = new URL(url, origin);
		if (parsed.pathname.startsWith(MEDIA_PREFIX)) {
			const key = parsed.pathname.slice(MEDIA_PREFIX.length).split("/").map(decodeURIComponent).join("/");
			const object = await getObject(key);
			if (object) return object.body;
		}
		const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
		return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
	} catch {
		return null;
	}
}

function respond(bytes: Uint8Array, slug: string, format: ShareFormat, download: boolean): Response {
	const headers: Record<string, string> = {
		"content-type": "image/png",
		"cache-control": "public, max-age=86400, stale-while-revalidate=604800",
	};
	if (download) headers["content-disposition"] = `attachment; filename="checkclimate-${slug}-${format}.png"`;
	return new Response(bytes as unknown as BodyInit, { headers });
}

export const GET: APIRoute = async ({ params, url }) => {
	const format = params.format;
	const slug = params.slug ?? "";
	if (!isFormat(format) || !/^[a-z0-9-]{1,200}$/.test(slug)) return new Response("Not found", { status: 404 });

	const { entry } = await getEmDashEntry("posts", slug);
	const post = entry as Post | null;
	const data = post?.data;
	if (!post || !data || !isFactCheck(post) || typeof data.claim !== "string" || !data.claim || !data.verdict) {
		return new Response("No share card for this post", { status: 404 });
	}

	const origin = url.origin;
	const input = {
		claim: data.claim,
		claimSource: data.claim_source ?? null,
		verdict: String(data.verdict),
		summary: data.verdict_summary ?? null,
		host: BRAND_HOST,
	};
	const imageRef = JSON.stringify(data.featured_image ?? null);
	const key = `share/${format}/${slug}-${await sha(JSON.stringify([DESIGN_VERSION, format, input, imageRef]))}.png`;
	const download = url.searchParams.has("download");

	const stored = await getObject(key);
	if (stored) return respond(stored.body, slug, format, download);

	try {
		const card = await renderCard({
			format,
			layout: shareLayout(format, input),
			photo: await photoBytes(origin, data.featured_image),
		});
		// A card that cannot be cached is still worth returning: the next
		// request redraws it, which on this box costs milliseconds.
		await putObject(key, card, "image/png", { source: "share-card", slug });
		return respond(card, slug, format, download);
	} catch (error) {
		console.error("share card failed", slug, format, error);
		return new Response("The share image could not be drawn right now.", {
			status: 503,
			headers: { "cache-control": "no-store", "retry-after": "60" },
		});
	}
};
