import type { CacheHint } from "emdash";
import { getEmDashCollection } from "emdash";
import {
	categoriesOf,
	bylinesOf,
	excerptOf,
	publishedAt,
	postPath,
	titleWithoutKicker,
	type Post,
} from "./content";
import { portableTextToHtml } from "./portable-text-html";
import { publicMediaUrl } from "./media-url";

/**
 * RSS 2.0 for the story archive, with a feed per category. WordPress readers
 * still point at /feed/, so that URL stays and the XML stays the same shape
 * (full content, categories, author, pubDate, guid permalink).
 */

const FEED_LIMIT = 20;

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function cdata(value: string): string {
	// A CDATA section cannot contain "]]>"; split it if the content does.
	return `<![CDATA[${value.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function itemXml(post: Post, origin: string): string {
	const url = new URL(postPath(post), origin).toString();
	const title = titleWithoutKicker(post);
	const description = excerptOf(post) || title;
	const html = portableTextToHtml(post.data.content, {
		origin,
		absoluteLinks: true,
		// Feed readers fetch the original from the media domain when it is set.
		mediaUrl: (stored) => publicMediaUrl(stored),
	});
	const authors = bylinesOf(post)
		.map((byline) => escapeXml(byline.name ?? ""))
		.filter(Boolean);
	const categories = categoriesOf(post).map((term) =>
		`<category>${escapeXml(term.label)}</category>`,
	);

	return [
		"<item>",
		`<title>${escapeXml(title)}</title>`,
		`<link>${escapeXml(url)}</link>`,
		`<guid isPermaLink="true">${escapeXml(url)}</guid>`,
		`<pubDate>${publishedAt(post).toUTCString()}</pubDate>`,
		`<description>${cdata(description)}</description>`,
		html ? `<content:encoded>${cdata(html)}</content:encoded>` : "",
		...authors.map((author) => `<dc:creator>${author}</dc:creator>`),
		...categories,
		"</item>",
	]
		.filter(Boolean)
		.join("");
}

export interface FeedResult {
	body: string;
	cacheHint?: CacheHint;
}

export async function buildFeed(options: {
	title: string;
	description: string;
	path: string;
	origin: string;
	where?: Record<string, string>;
}): Promise<FeedResult> {
	const { title, description, path, origin, where } = options;
	const result = await getEmDashCollection("posts", {
		...(where ? { where } : {}),
		orderBy: { published_at: "desc" },
		limit: FEED_LIMIT,
	});

	const self = new URL(path, origin).toString();
	const home = new URL("/", origin).toString();
	const posts = result.entries as Post[];
	const lastBuild = posts[0] ? publishedAt(posts[0]).toUTCString() : new Date().toUTCString();

	const body = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">',
		"<channel>",
		`<title>${escapeXml(title)}</title>`,
		`<link>${escapeXml(home)}</link>`,
		`<description>${escapeXml(description)}</description>`,
		"<language>en</language>",
		`<lastBuildDate>${lastBuild}</lastBuildDate>`,
		`<atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml" />`,
		...posts.map((post) => itemXml(post, origin)),
		"</channel>",
		"</rss>",
	].join("");

	return { body, cacheHint: result.cacheHint };
}

export function feedResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "application/rss+xml; charset=utf-8",
			"cache-control": "public, max-age=300",
		},
	});
}
