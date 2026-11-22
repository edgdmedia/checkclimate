/**
 * Fact-check share card: /share/wide/<slug>.png (1200×630, the link preview)
 * and /share/portrait/<slug>.png (1080×1350, Instagram / WhatsApp Status).
 * Add ?download to get it as an attachment.
 *
 * Drawn with the Workers Images binding from the post's claim and verdict
 * fields (layout: src/utils/share-card.ts) over the post photo, heavily
 * faded under a green shade. Each render is stored in R2 under a key that
 * hashes everything drawn, so an edit to the post makes a new card and
 * repeat requests never re-render.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getEmDashEntry } from "emdash";
import type { Post } from "../../../utils/content";
import { imageUrl, isFactCheck } from "../../../utils/content";
import { SHARE_SIZES, shareLayout, type FontWeight, type ShareFormat } from "../../../utils/share-card";

/** Bump when the design changes, so stored cards are redrawn. */
const DESIGN_VERSION = "3";
const BRAND_HOST = "checkclimate.africa";
const MEDIA_PREFIX = "/_emdash/api/media/file/";
/** How much of the photo shows before the shade goes on top. */
const PHOTO_OPACITY = 0.35;
/** The Images service takes at most 10 transforms per chain; draw in rounds. */
const DRAWS_PER_ROUND = 9;

function isFormat(value: string | undefined): value is ShareFormat {
	return value === "wide" || value === "portrait";
}

async function sha(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function asset(origin: string, path: string): Promise<ReadableStream<Uint8Array>> {
	const response = await env.ASSETS.fetch(new URL(path, origin));
	if (!response.ok || !response.body) throw new Error(`asset ${path}: ${response.status}`);
	return response.body;
}

/** The post photo as a stream: straight from R2 for media-library files. */
async function photo(origin: string, image: unknown): Promise<ReadableStream<Uint8Array> | null> {
	const url = imageUrl(origin, image);
	if (!url) return null;
	try {
		const parsed = new URL(url);
		if (parsed.origin === origin && parsed.pathname.startsWith(MEDIA_PREFIX)) {
			const key = parsed.pathname.slice(MEDIA_PREFIX.length).split("/").map(decodeURIComponent).join("/");
			const object = await env.MEDIA.get(key);
			if (object) return object.body;
		}
		const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
		return response.ok && response.body ? response.body : null;
	} catch {
		return null;
	}
}

function respond(bytes: ArrayBuffer, slug: string, format: ShareFormat, download: boolean): Response {
	const headers: Record<string, string> = {
		"content-type": "image/png",
		"cache-control": "public, max-age=3600, stale-while-revalidate=86400",
	};
	if (download) headers["content-disposition"] = `attachment; filename="checkclimate-${slug}-${format}.png"`;
	return new Response(bytes, { headers });
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

	const stored = await env.MEDIA.get(key);
	if (stored) return respond(await new Response(stored.body).arrayBuffer(), slug, format, download);

	try {
		const { width, height } = SHARE_SIZES[format];
		let card = env.IMAGES.input(await asset(origin, `/share/base-${format}.png`));

		// Overlays are drawn in rounds (the service allows 10 transforms per
		// chain). Within a round it applies image overlays before text ones and
		// pairs the positions in that order, so each round is queued and sent
		// images first: every overlay keeps its own position, and text still
		// lands on top of the stamp it belongs to.
		type Queued = { overlay: ImagesHandleLike; at: { left: number; top: number; opacity?: number }; text: boolean };
		let round: Queued[] = [];
		const flush = async (final: boolean) => {
			const ordered = [...round.filter((q) => !q.text), ...round.filter((q) => q.text)];
			for (const q of ordered) card = card.draw(q.overlay, q.at);
			round = [];
			if (final) return;
			const flat = (await card.output({ format: "image/png" })).response().body;
			if (!flat) throw new Error("empty intermediate image");
			card = env.IMAGES.input(flat);
		};
		const draw = async (item: Queued) => {
			if (round.length === DRAWS_PER_ROUND) await flush(false);
			round.push(item);
		};

		const background = await photo(origin, data.featured_image);
		if (background) {
			await draw({
				overlay: env.IMAGES.input(background).transform({ width, height, fit: "cover" }),
				at: { left: 0, top: 0, opacity: PHOTO_OPACITY },
				text: false,
			});
		}
		await draw({ overlay: env.IMAGES.input(await asset(origin, `/share/shade-${format}.png`)), at: { left: 0, top: 0 }, text: false });

		const font = (weight: FontWeight) => ({ url: `${origin}/fonts/red-hat-display-latin-${weight}-normal.woff2` });
		for (const op of shareLayout(format, input).ops) {
			await draw(
				op.kind === "asset"
					? { overlay: env.IMAGES.input(await asset(origin, op.path)), at: { left: op.left, top: op.top }, text: false }
					: { overlay: env.IMAGES.text(op.text, { font: font(op.weight), color: op.color, size: op.size }), at: { left: op.left, top: op.top }, text: true },
			);
		}
		await flush(true);

		const bytes = await (await card.output({ format: "image/png" })).response().arrayBuffer();
		await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
		return respond(bytes, slug, format, download);
	} catch (error) {
		console.error("share card failed", slug, format, error);
		return new Response("The share image could not be drawn right now.", {
			status: 503,
			headers: { "cache-control": "no-store", "retry-after": "60" },
		});
	}
};
