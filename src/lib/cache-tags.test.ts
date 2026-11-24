import { describe, expect, it } from "vitest";
import { collectionsForPath, tagsForPath } from "./cache-tags";

describe("collectionsForPath", () => {
	it("covers the WordPress URL shapes", () => {
		expect(collectionsForPath("/")).toEqual(["posts", "pages"]);
		expect(collectionsForPath("/2025/04/18/flood-forecast-lagos/")).toEqual(["posts"]);
		expect(collectionsForPath("/2025/04/18/flood-forecast-lagos")).toEqual(["posts"]);
		expect(collectionsForPath("/posts/")).toEqual(["posts"]);
		expect(collectionsForPath("/posts/page/2")).toEqual(["posts"]);
		expect(collectionsForPath("/category/fact-check/page/2/")).toEqual(["posts"]);
		expect(collectionsForPath("/tag/climate-action/")).toEqual(["posts"]);
		expect(collectionsForPath("/author/lanre-adebayo/")).toEqual(["posts"]);
		expect(collectionsForPath("/about-us/")).toEqual(["pages", "posts"]);
		expect(collectionsForPath("/feed/")).toEqual(["posts"]);
		expect(collectionsForPath("/category/fact-check/feed/")).toEqual(["posts"]);
		expect(collectionsForPath("/sitemap.xml")).toEqual(["posts", "pages"]);
		expect(collectionsForPath("/sitemap-posts.xml")).toEqual(["posts", "pages"]);
		expect(collectionsForPath("/robots.txt")).toEqual(["posts", "pages"]);
	});

	it("never caches the admin, the API, forms, search or asset routes", () => {
		for (const path of [
			"/_emdash/admin",
			"/_emdash/api/media/file/x.png",
			"/_image?url=/x.png",
			"/_astro/app.abc123.js",
			"/admin/",
			"/login",
			"/search/",
			"/submit-a-claim/",
			"/api/weather",
			"/wp-admin/profile.php",
		]) {
			expect(collectionsForPath(path), path).toEqual([]);
		}
	});

	it("does not invent a directory for a dotted last segment", () => {
		// "/feed.xml" is a file; the trailing-slash rule must not turn the check
		// into a redirect chain by classifying it as something else.
		expect(collectionsForPath("/feed.xml")).toEqual(["posts"]);
		expect(collectionsForPath("/no/such/deep/path/")).toEqual([]);
	});
});

describe("tagsForPath", () => {
	it("carries the collections, the chrome and the emergency tag", () => {
		const tags = tagsForPath("/");
		expect(tags).toContain("posts");
		expect(tags).toContain("pages");
		expect(tags).toContain("emdash:settings");
		expect(tags).toContain("all");
	});

	it("is empty where nothing may be cached", () => {
		expect(tagsForPath("/admin/")).toEqual([]);
		expect(tagsForPath("/search/")).toEqual([]);
	});
});
