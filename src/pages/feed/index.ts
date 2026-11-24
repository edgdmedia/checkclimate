import type { APIRoute } from "astro";
import { getSiteSettingsWithCacheHint } from "emdash";
import { buildFeed, feedResponse } from "../../utils/feed";

/** WordPress' feed URL, kept. Full-content RSS 2.0 for the newest stories. */
export const GET: APIRoute = async ({ site, url }) => {
	const origin = (site ?? new URL(url.origin)).toString();
	const settings = await getSiteSettingsWithCacheHint();
	const title = settings.data?.title ?? "Check Climate Africa";
	const tagline =
		settings.data?.tagline ?? "Disseminating Critical Climate Information";

	const feed = await buildFeed({
		title,
		description: tagline,
		path: "/feed/",
		origin,
	});

	return feedResponse(feed.body);
};
