/**
 * Purges Cloudflare's zone cache when content changes.
 *
 * On this deployment the only shared cache is Cloudflare's edge, in front of
 * the origin. A public page is kept for 30 days (`s-maxage` in
 * src/middleware.ts) and carries a `Cache-Tag` header with the groups it
 * belongs to — the collections it shows ("posts", "pages"), the chrome tags
 * and "all" (src/lib/cache-tags.ts). The plugin asks Cloudflare to drop a group
 * when content changes, so the two files must agree on the names: they are the
 * same names EmDash invalidates in its own query cache after a write.
 *
 * The tags are per path, not per entry: purging "posts" drops the home page,
 * every archive, the feeds and the post itself — nearly the whole site. That is
 * deliberate. A re-render on this box costs no quota, and one request per
 * publish keeps well inside Cloudflare's free-plan purge budget (5 a minute).
 *
 * Purged on: publish, unpublish, delete, restore, and a save to an entry that
 * is already published. The last one matters: post bodies wait for Publish,
 * but live metadata (a taxonomy term, an SEO field) is written straight to the
 * live row and fires only content:afterSave. That hook also fires on every
 * draft autosave and cannot tell the two apart, so saves are debounced: one
 * purge, 30 s after the last of a burst.
 *
 * Not purged: a site-settings edit (the chrome tags exist so an operator can
 * purge by tag by hand). The 5-minute `max-age` on the browser side bounds it.
 *
 * Configuration (environment):
 *   CLOUDFLARE_ZONE_ID       the zone of checkclimate.africa        (required)
 *   CLOUDFLARE_API_TOKEN     a token with Zone > Cache Purge        (required)
 *   CLOUDFLARE_PURGE_ENABLED set to "0" to switch the plugin off
 *
 * Without a token the plugin does nothing but say so once. A failed purge is
 * logged loudly: the edge would keep serving the old page until its 30 days are
 * up, so the desk has to know about it.
 */
import { definePlugin } from "emdash";
import { purgeConfig } from "./env.mjs";

const ID = "checkclimate-cloudflare-purge";
const VERSION = "1.0.0";
// content:read for the content hooks, users:read for comment:afterModerate and
// bylines:read for byline:afterSave — each is the capability the hook
// reference names for that hook.
const CAPABILITIES = ["content:read", "users:read", "bylines:read"];

// Cloudflare's Free plan allows 5 purge requests a minute; a bulk import is
// many, so a rate-limited answer is retried with a backoff.
const RETRY_DELAYS_MS = [1_000, 5_000, 20_000];
const MAX_TAG_LENGTH = 1024;
const MAX_TAGS_PER_REQUEST = 100;

// A save to a published entry purges this long after the last save of a burst.
const SAVE_DEBOUNCE_MS = 30_000;
const pendingSaves = new Map();

let warned = false;

/** The descriptor `astro.config.mjs` registers. Plain data, no EmDash import. */
export function cloudflarePurge(options = {}) {
	return {
		id: ID,
		displayName: "Cloudflare purge",
		description: "Purges the zone cache by Cache-Tag when content changes.",
		version: VERSION,
		format: "native",
		entrypoint: "@checkclimate/plugin-cloudflare-purge",
		capabilities: CAPABILITIES,
		options,
	};
}

export function createPlugin(options = {}) {
	return definePlugin({
		id: ID,
		version: VERSION,
		capabilities: CAPABILITIES,
		hooks: {
			"content:afterPublish": {
				handler: async (event, ctx) => {
					await purgeEntry(event, ctx, "publish");
				},
			},
			"content:afterSave": {
				handler: async (event, ctx) => {
					if (event.content?.status !== "published") return;
					const key = `${event.collection}:${event.content.id}`;
					clearTimeout(pendingSaves.get(key));
					const timer = setTimeout(() => {
						pendingSaves.delete(key);
						purgeEntry(event, ctx, "save").catch(() => {});
					}, SAVE_DEBOUNCE_MS);
					// A pending purge must never hold the process open on exit.
					timer.unref?.();
					pendingSaves.set(key, timer);
				},
			},
			"content:afterUnpublish": {
				handler: async (event, ctx) => {
					await purgeEntry(event, ctx, "unpublish");
				},
			},
			"content:afterDelete": {
				handler: async (event, ctx) => {
					// The delete event carries { id, collection }, not the content.
					await purgeTags([event.collection, event.id], ctx, "delete");
				},
			},
			"content:afterRestore": {
				handler: async (event, ctx) => {
					await purgeEntry(event, ctx, "restore");
				},
			},
			// An approval changes what the article page shows (src/components/
			// Comments.astro renders the approved list), and a byline edit changes
			// every page that names the author. Neither is a content save, so the
			// hooks above would leave both stale at the edge for 30 days.
			"comment:afterModerate": {
				handler: async (event, ctx) => {
					if (event.newStatus === "pending" || event.newStatus === "spam") {
						if (event.previousStatus !== "approved") return;
					}
					await purgeTags(["posts"], ctx, "comment");
				},
			},
			"byline:afterSave": {
				handler: async (event, ctx) => {
					await purgeTags(["posts", "pages"], ctx, "byline");
				},
			},
		},
	});
}

export default createPlugin;

/**
 * Purge the collection of a content change. The entry id rides along: it costs
 * nothing, and it keeps working if pages ever carry per-entry tags.
 */
async function purgeEntry(event, ctx, action) {
	const id = typeof event.content?.id === "string" ? event.content.id : undefined;
	await purgeTags([event.collection, id], ctx, action);
}

/**
 * One `POST /zones/:id/purge_cache` with retry on 429.
 *
 * `settings` exists for the test: `fetch` and the backoff ladder can be
 * replaced so a retry case runs in milliseconds. Production calls it with
 * nothing, and the defaults are the ones above.
 */
export async function purgeTags(rawTags, ctx, action, settings = {}) {
	const fetchImpl = settings.fetch ?? fetch;
	const delays = settings.retryDelaysMs ?? RETRY_DELAYS_MS;
	const tags = (rawTags ?? [])
		.filter((tag) => typeof tag === "string" && tag.length > 0)
		.map((tag) => tag.slice(0, MAX_TAG_LENGTH));
	if (tags.length === 0) return { attempted: false, ok: false, reason: "no-tags" };

	const { zoneId, apiToken, enabled } = settings.config ?? purgeConfig();
	if (!enabled) return { attempted: false, ok: false, reason: "disabled" };
	if (!zoneId || !apiToken) {
		if (!warned) {
			warned = true;
			ctx.log.warn(
				"[cloudflare-purge] no CLOUDFLARE_ZONE_ID / CLOUDFLARE_API_TOKEN — the edge cache is not purged on publish",
			);
		}
		return { attempted: false, ok: false, reason: "not-configured" };
	}

	const body = { tags: tags.slice(0, MAX_TAGS_PER_REQUEST) };
	const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;

	for (let attempt = 0; attempt <= delays.length; attempt++) {
		if (attempt > 0) await sleep(delays[attempt - 1]);
		try {
			const response = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(15_000),
			});
			const payload = await response.json().catch(() => ({}));
			if (response.ok && payload?.success !== false) {
				ctx.log.info("[cloudflare-purge] purged", { action, tags: body.tags });
				return { attempted: true, ok: true, attempts: attempt + 1 };
			}
			// 429 is the plan's rate limit, which a retry can clear. Anything else
			// is a permission or configuration problem, which one cannot.
			if (response.status !== 429) {
				ctx.log.error("[cloudflare-purge] purge failed", {
					action,
					tags: body.tags,
					status: response.status,
					errors: payload?.errors,
				});
				return { attempted: true, ok: false, status: response.status };
			}
			ctx.log.warn("[cloudflare-purge] rate limited, retrying", { action, attempt });
		} catch (error) {
			ctx.log.error("[cloudflare-purge] purge request failed", {
				action,
				tags: body.tags,
				error: String(error),
			});
			return { attempted: true, ok: false, error: String(error) };
		}
	}
	ctx.log.error("[cloudflare-purge] purge gave up after retries", { action, tags: body.tags });
	return { attempted: true, ok: false, reason: "rate-limited" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
