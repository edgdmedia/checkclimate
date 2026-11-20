import { describe, expect, it } from "vitest";
import {
	collectWaybackEdits,
	extractWrappedUrls,
	hostVariants,
	isOwnSiteOriginal,
	lookupMediaUrl,
	rootRelativePath,
	unwrapWayback,
} from "./wayback";

describe("unwrapWayback", () => {
	it("unwraps a plain Wayback URL", () => {
		const result = unwrapWayback(
			"https://web.archive.org/web/20201001000000/https://www.checkclimate.africa/wp-content/uploads/2020/07/x.jpg",
		);
		expect(result).not.toBeNull();
		expect(result!.original).toBe(
			"https://www.checkclimate.africa/wp-content/uploads/2020/07/x.jpg",
		);
		expect(result!.timestamp).toBe("20201001000000");
		expect(result!.flag).toBe("");
	});

	it.each(["id_", "im_", "if_", "js_", "cs_"])("parses the %s flag", (flag) => {
		const result = unwrapWayback(`https://web.archive.org/web/20201001000000${flag}/https://example.com/a`);
		expect(result).not.toBeNull();
		expect(result!.flag).toBe(flag);
		expect(result!.original).toBe("https://example.com/a");
	});

	it("normalises a single-slash https:/ original", () => {
		const result = unwrapWayback(
			"https://web.archive.org/web/20201001000000/https:/www.checkclimate.africa/tag/climate-change/",
		);
		expect(result).not.toBeNull();
		expect(result!.original).toBe("https://www.checkclimate.africa/tag/climate-change/");
	});

	it("normalises a single-slash http:/ original", () => {
		const result = unwrapWayback("https://web.archive.org/web/20201001000000/http:/example.com/a");
		expect(result).not.toBeNull();
		expect(result!.original).toBe("http://example.com/a");
	});

	it("unwraps nested Wayback wrappers and keeps the innermost timestamp", () => {
		const result = unwrapWayback(
			"https://web.archive.org/web/20210101000000/https://web.archive.org/web/20200101000000/https://www.checkclimate.africa/2020/05/01/a-post/",
		);
		expect(result).not.toBeNull();
		expect(result!.original).toBe("https://www.checkclimate.africa/2020/05/01/a-post/");
		expect(result!.timestamp).toBe("20200101000000");
	});

	it("keeps an archive.ph original as a citation, not a wrapper", () => {
		const result = unwrapWayback("https://web.archive.org/web/20210101000000/https://archive.ph/abcd");
		expect(result).not.toBeNull();
		expect(result!.original).toBe("https://archive.ph/abcd");
	});

	it("keeps an archive.today original as a citation, not a wrapper", () => {
		const result = unwrapWayback(
			"https://web.archive.org/web/20210101000000/https://archive.today/20200101000000/https://example.com/a",
		);
		expect(result).not.toBeNull();
		expect(result!.original).toBe("https://archive.today/20200101000000/https://example.com/a");
	});

	it("accepts an http wrapper", () => {
		const result = unwrapWayback("http://web.archive.org/web/20200101000000/https://example.com/a");
		expect(result).not.toBeNull();
		expect(result!.original).toBe("https://example.com/a");
	});

	it("preserves the original's query string", () => {
		const result = unwrapWayback(
			"https://web.archive.org/web/20200101000000/https://www.checkclimate.africa/?p=123",
		);
		expect(result).not.toBeNull();
		expect(result!.original).toBe("https://www.checkclimate.africa/?p=123");
	});

	it("returns null for a URL that is not wrapped", () => {
		expect(unwrapWayback("https://www.checkclimate.africa/x.jpg")).toBeNull();
		expect(unwrapWayback("https://archive.ph/abcd")).toBeNull();
		expect(unwrapWayback("/tag/climate-change/")).toBeNull();
		expect(unwrapWayback("")).toBeNull();
	});

	it("returns null for malformed wrappers", () => {
		expect(unwrapWayback("https://web.archive.org/web/")).toBeNull();
		expect(unwrapWayback("https://web.archive.org/web/123/https://example.com")).toBeNull();
		// 15 digits is not a Wayback timestamp.
		expect(unwrapWayback("https://web.archive.org/web/202001010000001/https://example.com")).toBeNull();
		expect(unwrapWayback("https://web.archive.org/web/20200101000000/")).toBeNull();
	});
});

describe("isOwnSiteOriginal", () => {
	it("accepts the apex and www host", () => {
		expect(isOwnSiteOriginal("https://checkclimate.africa/x")?.pathname).toBe("/x");
		expect(isOwnSiteOriginal("https://www.checkclimate.africa/x")?.pathname).toBe("/x");
		expect(isOwnSiteOriginal("HTTPS://WWW.CHECKCLIMATE.AFRICA/x")?.pathname).toBe("/x");
	});

	it("rejects other hosts and lookalikes", () => {
		expect(isOwnSiteOriginal("https://example.com/x")).toBeNull();
		expect(isOwnSiteOriginal("https://archive.ph/abcd")).toBeNull();
		expect(isOwnSiteOriginal("https://fakecheckclimate.africa/x")).toBeNull();
		expect(isOwnSiteOriginal("https://checkclimate.africa.example.com/x")).toBeNull();
		expect(isOwnSiteOriginal("https://web.archive.org/web/20200101000000/https://example.com")).toBeNull();
	});

	it("accepts a scheme-less original on our own host", () => {
		expect(isOwnSiteOriginal("www.checkclimate.africa/x")?.pathname).toBe("/x");
	});
});

describe("rootRelativePath", () => {
	it("keeps WordPress paths as root-relative routes", () => {
		expect(rootRelativePath("https://www.checkclimate.africa/tag/climate-change/")).toBe(
			"/tag/climate-change/",
		);
		expect(rootRelativePath("https://checkclimate.africa/2020/07/09/a-post/")).toBe(
			"/2020/07/09/a-post/",
		);
	});

	it("keeps query strings and fragments", () => {
		expect(rootRelativePath("https://www.checkclimate.africa/?p=123")).toBe("/?p=123");
		expect(rootRelativePath("https://www.checkclimate.africa/page/2/#fact-1")).toBe("/page/2/#fact-1");
	});

	it("maps the homepage to /", () => {
		expect(rootRelativePath("https://www.checkclimate.africa/")).toBe("/");
	});
});

describe("lookupMediaUrl", () => {
	const map = {
		"https://www.checkclimate.africa/wp-content/uploads/2020/07/x.jpg":
			"/_emdash/api/media/file/01AAA.jpg",
		"https://checkclimate.africa/wp-content/uploads/2020/07/y.jpg": "/_emdash/api/media/file/01BBB.jpg",
		"https://www.checkclimate.africa/wp-content/uploads/2020/07/full.jpg?w=9":
			"/_emdash/api/media/file/01CCC.jpg",
	};

	it("matches the exact URL", () => {
		expect(lookupMediaUrl(map, "https://www.checkclimate.africa/wp-content/uploads/2020/07/x.jpg")).toBe(
			"/_emdash/api/media/file/01AAA.jpg",
		);
	});

	it("matches the same path on the other host variant", () => {
		expect(lookupMediaUrl(map, "https://checkclimate.africa/wp-content/uploads/2020/07/x.jpg")).toBe(
			"/_emdash/api/media/file/01AAA.jpg",
		);
		expect(lookupMediaUrl(map, "https://www.checkclimate.africa/wp-content/uploads/2020/07/y.jpg")).toBe(
			"/_emdash/api/media/file/01BBB.jpg",
		);
	});

	it("matches the same path over http", () => {
		expect(lookupMediaUrl(map, "http://www.checkclimate.africa/wp-content/uploads/2020/07/x.jpg")).toBe(
			"/_emdash/api/media/file/01AAA.jpg",
		);
	});

	it("matches a WordPress size variant against the full-size original", () => {
		expect(
			lookupMediaUrl(map, "https://www.checkclimate.africa/wp-content/uploads/2020/07/x-300x169.jpg"),
		).toBe("/_emdash/api/media/file/01AAA.jpg");
	});

	it("matches a mapped URL that carries a query string", () => {
		expect(lookupMediaUrl(map, "https://www.checkclimate.africa/wp-content/uploads/2020/07/full.jpg")).toBe(
			"/_emdash/api/media/file/01CCC.jpg",
		);
	});

	it("returns null when nothing matches", () => {
		expect(lookupMediaUrl(map, "https://www.checkclimate.africa/wp-content/uploads/2021/01/other.jpg")).toBeNull();
	});
});

describe("hostVariants", () => {
	it("swaps www/apex and http/https", () => {
		const variants = hostVariants("https://www.checkclimate.africa/a");
		expect(variants).toContain("https://www.checkclimate.africa/a");
		expect(variants).toContain("https://checkclimate.africa/a");
		expect(variants).toContain("http://www.checkclimate.africa/a");
		expect(variants).toContain("http://checkclimate.africa/a");
		expect(new Set(variants).size).toBe(4);
	});
});

describe("collectWaybackEdits", () => {
	it("collects markDefs hrefs on text blocks", () => {
		const blocks = [
			{
				_type: "block",
				style: "normal",
				children: [{ _type: "span", text: "a link", marks: ["k1"], _key: "s1" }],
				markDefs: [
					{ _key: "k1", _type: "link", href: "https://web.archive.org/web/20200101000000/https://www.checkclimate.africa/tag/x/" },
				],
				_key: "b1",
			},
		];
		const { fields } = collectWaybackEdits(blocks);
		expect(fields).toHaveLength(1);
		expect(fields[0]!.kind).toBe("link");
		expect(fields[0]!.field).toBe("markDefs[k1].href");
		expect(fields[0]!.wrappedUrl).toBe(
			"https://web.archive.org/web/20200101000000/https://www.checkclimate.africa/tag/x/",
		);
	});

	it("collects image asset refs and their alt text", () => {
		const asset = {
			_ref: "https://web.archive.org/web/20200101000000id_/https:/www.checkclimate.africa/wp-content/uploads/2020/07/x.jpg",
			url: "https://web.archive.org/web/20200101000000/https:/www.checkclimate.africa/wp-content/uploads/2020/07/x.jpg",
		};
		const blocks = [
			{ _type: "image", _key: "i1", asset, alt: "A chart", caption: "Fig 1", srcset: "a 1x" },
		];
		const { fields } = collectWaybackEdits(blocks);
		expect(fields).toHaveLength(2);
		expect(fields.map((f) => f.field).sort()).toEqual(["asset._ref", "asset.url"]);
		expect(fields[0]!.kind).toBe("image");
		expect(fields[0]!.alt).toBe("A chart");
		expect(fields[0]!.block).toBe(blocks[0]);
	});

	it("collects a linked image's href", () => {
		const blocks = [
			{
				_type: "image",
				_key: "i1",
				asset: { _ref: "m1", url: "/_emdash/api/media/file/m1.jpg" },
				link: { href: "https://web.archive.org/web/20200101000000/https://www.checkclimate.africa/2020/01/01/a/", blank: true },
			},
		];
		const { fields } = collectWaybackEdits(blocks);
		expect(fields).toHaveLength(1);
		expect(fields[0]!.field).toBe("link.href");
		expect(fields[0]!.kind).toBe("link");
	});

	it("walks galleries, columns, tables and buttons", () => {
		const wrapped = "https://web.archive.org/web/20200101000000/https://www.checkclimate.africa/a/";
		const blocks = [
			{ _type: "gallery", _key: "g1", images: [{ _type: "image", _key: "i1", asset: { _ref: wrapped, url: wrapped } }] },
			{
				_type: "columns",
				_key: "c1",
				columns: [
					{ _key: "col1", content: [{ _type: "block", _key: "b2", children: [], markDefs: [{ _key: "k9", _type: "link", href: wrapped }] }] },
				],
			},
			{
				_type: "table",
				_key: "t1",
				rows: [{ cells: [{ markDefs: [{ _key: "k8", _type: "link", href: wrapped }] }] }],
			},
			{ _type: "buttons", _key: "bs1", buttons: [{ _key: "b1", url: wrapped }] },
			{ _type: "file", _key: "f1", url: wrapped },
		];
		const { fields } = collectWaybackEdits(blocks);
		expect(fields.length).toBeGreaterThanOrEqual(5);
	});

	it("treats htmlBlock and embed html as string fields", () => {
		const blocks = [
			{
				_type: "htmlBlock",
				_key: "h1",
				html: '<figure><img src="https://web.archive.org/web/20200101000000/https:/www.checkclimate.africa/wp-content/uploads/x.jpg" srcset="https://web.archive.org/web/20200101000000/https:/www.checkclimate.africa/wp-content/uploads/x-300x169.jpg 300w" alt="a"></figure>',
			},
			{ _type: "embed", _key: "e1", url: "https://web.archive.org/web/20200101000000/https://www.checkclimate.africa/b/", html: "<p>hi</p>" },
		];
		const { fields, strings } = collectWaybackEdits(blocks);
		expect(fields).toHaveLength(1); // embed.url
		expect(fields[0]!.field).toBe("url");
		expect(strings).toHaveLength(1);
		expect(strings[0]!.field).toBe("html");
		const urls = extractWrappedUrls(strings[0]!.html);
		expect(urls).toHaveLength(2);
		expect(urls[0]).toBe(
			"https://web.archive.org/web/20200101000000/https:/www.checkclimate.africa/wp-content/uploads/x.jpg",
		);
		expect(urls[1]).toBe(
			"https://web.archive.org/web/20200101000000/https:/www.checkclimate.africa/wp-content/uploads/x-300x169.jpg",
		);
	});

	it("ignores content without wrapped URLs", () => {
		const blocks = [
			{ _type: "block", _key: "b1", children: [{ _type: "span", text: "clean", _key: "s1" }], markDefs: [] },
			{ _type: "image", _key: "i1", asset: { _ref: "m1", url: "/_emdash/api/media/file/m1.jpg" } },
			{ _type: "htmlBlock", _key: "h1", html: '<img src="https://example.com/a.jpg">' },
		];
		const { fields, strings } = collectWaybackEdits(blocks);
		expect(fields).toHaveLength(0);
		expect(strings).toHaveLength(0);
	});
});
