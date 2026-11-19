import type { APIRoute } from "astro";
import { getTaxonomyTermsWithCacheHint } from "emdash";
import { decodeSlug } from "emdash";
import { buildFeed, feedResponse } from "../../../../utils/feed";

/** A feed per section: /category/fact-check/feed/ and friends. */
export const GET: APIRoute = async ({ params, site, url, cache }) => {
	const slug = decodeSlug(params.slug) ?? "";
	const origin = (site ?? new URL(url.origin)).toString();

	const terms = await getTaxonomyTermsWithCacheHint("category", {
		includeCounts: false,
	});
	const term = terms.data.find((item) => item.slug === slug);
	if (!term) return new Response("No such category", { status: 404 });

	const feed = await buildFeed({
		title: `${term.label} — Check Climate Africa`,
		description: `Stories and fact checks filed under ${term.label}.`,
		path: `/category/${slug}/feed/`,
		origin,
		where: { category: slug },
	});

	if (cache?.enabled) {
		cache.set(terms.cacheHint);
		if (feed.cacheHint) cache.set(feed.cacheHint);
	}

	return feedResponse(feed.body);
};
