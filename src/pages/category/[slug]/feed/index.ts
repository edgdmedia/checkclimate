import type { APIRoute } from "astro";
import { getTaxonomyTermsWithCacheHint } from "emdash";
import { decodeSlug } from "emdash";
import { buildFeed, feedResponse } from "../../../../utils/feed";
import { TYPE_SECTIONS } from "../../../../utils/content";
import { findTerm } from "../../../../utils/archive";

/** A feed per section: /category/fact-check/feed/ and friends. */
export const GET: APIRoute = async ({ params, site, url, cache }) => {
	const slug = decodeSlug(params.slug) ?? "";
	const origin = (site ?? new URL(url.origin)).toString();

	const typeSection = TYPE_SECTIONS[slug];
	const terms = await getTaxonomyTermsWithCacheHint("category", {
		includeCounts: false,
	});
	const label = typeSection?.label ?? findTerm(terms.data, slug)?.label;
	if (!label) return new Response("No such category", { status: 404 });

	const feed = await buildFeed({
		title: `${label} — Check Climate Africa`,
		description: `Stories and fact checks filed under ${label}.`,
		path: `/category/${slug}/feed/`,
		origin,
		where: typeSection ? { kicker: typeSection.type } : { category: slug },
	});

	if (cache?.enabled) {
		cache.set(terms.cacheHint);
		if (feed.cacheHint) cache.set(feed.cacheHint);
	}

	return feedResponse(feed.body);
};
