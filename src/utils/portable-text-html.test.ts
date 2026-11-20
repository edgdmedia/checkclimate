import { describe, expect, it } from "vitest";
import {
	escapeHtml,
	portableTextToHtml,
	portableTextToPlainText,
} from "./portable-text-html";

const ORIGIN = "https://www.checkclimate.africa";

/** The shapes EmDash's own converter produces (prosemirror-to-portable-text). */
function paragraph(text: string, extra: Record<string, unknown> = {}) {
	return {
		_type: "block",
		_key: "b1",
		style: "normal",
		children: [{ _type: "span", text }],
		...extra,
	};
}

function withLink(label: string, href: string, extra: Record<string, unknown> = {}) {
	return {
		_type: "block",
		_key: "b1",
		style: "normal",
		children: [{ _type: "span", text: label, marks: ["l1"] }],
		markDefs: [{ _key: "l1", _type: "link", href, ...extra }],
	};
}

describe("portableTextToHtml", () => {
	it("wraps plain blocks in paragraphs", () => {
		expect(portableTextToHtml([paragraph("Flooding hit Bama in May.")], { origin: ORIGIN })).toBe(
			"<p>Flooding hit Bama in May.</p>",
		);
	});

	it("escapes text and never passes markup through", () => {
		const html = portableTextToHtml([paragraph('<img src=x onerror="alert(1)">')], {
			origin: ORIGIN,
		});
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("renders marks and block-level link definitions", () => {
		const value = [
			{
				_type: "block",
				style: "normal",
				children: [
					{ _type: "span", text: "NEPCOM said " },
					{ _type: "span", text: "no ban", marks: ["strong"] },
					{ _type: "span", text: "the source", marks: ["l1"] },
				],
				markDefs: [
					{ _key: "l1", _type: "link", href: "https://example.org/a", blank: true },
				],
			},
		];
		const html = portableTextToHtml(value, { origin: ORIGIN });
		expect(html).toContain("<strong>no ban</strong>");
		expect(html).toContain('href="https://example.org/a"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("keeps site-relative links relative on the page and absolute in feeds", () => {
		const value = [withLink("the fact check", "/2025/07/09/no-snow/")];
		expect(portableTextToHtml(value, { origin: ORIGIN })).toContain(
			'href="/2025/07/09/no-snow/"',
		);
		expect(portableTextToHtml(value, { origin: ORIGIN, absoluteLinks: true })).toContain(
			`href="${ORIGIN}/2025/07/09/no-snow/"`,
		);
	});

	it("drops schemes that are not http, mailto, tel or a fragment", () => {
		const html = portableTextToHtml([withLink("click", "javascript:alert(1)")], {
			origin: ORIGIN,
		});
		expect(html).not.toContain("javascript:");
		expect(html).toBe("<p>click</p>");
	});

	it("groups list items, nests by level, and returns to prose after", () => {
		const value = [
			paragraph("first", { listItem: "number", level: 1 }),
			paragraph("second", { listItem: "number", level: 1 }),
			paragraph("deeper", { listItem: "bullet", level: 2 }),
			paragraph("after"),
		];
		expect(portableTextToHtml(value, { origin: ORIGIN })).toBe(
			"<ol>\n<li>first</li>\n<li>second</li>\n<ul>\n<li>deeper</li>\n</ul>\n</ol>\n<p>after</p>",
		);
	});

	it("promotes h1 to h2 so the page keeps one h1", () => {
		expect(portableTextToHtml([paragraph("Heading", { style: "h1" })], { origin: ORIGIN })).toBe(
			"<h2>Heading</h2>",
		);
	});

	it("resolves an EmDash image through asset.url, then asset._ref", () => {
		expect(
			portableTextToHtml(
				[
					{
						_type: "image",
						alt: "A flooded street",
						caption: "Bama, May 2025",
						asset: { url: "/_emdash/api/media/file/2025/07/bama.jpg" },
					},
				],
				{ origin: ORIGIN },
			),
		).toContain(`src="${ORIGIN}/_emdash/api/media/file/2025/07/bama.jpg"`);

		// A bare storage key still resolves: the media file route serves it.
		expect(
			portableTextToHtml([{ _type: "image", asset: { _ref: "2025/07/bama.jpg" } }], {
				origin: ORIGIN,
			}),
		).toContain(`src="${ORIGIN}/_emdash/api/media/file/2025/07/bama.jpg"`);

		const withAlt = portableTextToHtml(
			[{ _type: "image", alt: 'He said "hi"', asset: { url: "https://cdn.example/x.jpg" } }],
			{ origin: ORIGIN },
		);
		expect(withAlt).toContain('alt="He said &quot;hi&quot;"');
		expect(withAlt).toContain("https://cdn.example/x.jpg");
	});

	it("renders gallery images and keeps an embed as a link", () => {
		const html = portableTextToHtml(
			[
				{
					_type: "gallery",
					images: [
						{ _type: "image", asset: { url: "/a.jpg" } },
						{ _type: "image", asset: { url: "/b.jpg" } },
					],
				},
				{ _type: "iframe", src: "https://www.youtube.com/embed/abc", title: "The video" },
			],
			{ origin: ORIGIN },
		);
		expect(html).toContain('<div class="gallery">');
		expect(html).toContain(`${ORIGIN}/a.jpg`);
		expect(html).toContain('<a href="https://www.youtube.com/embed/abc">The video</a>');
	});

	it("strips runnable markup from imported HTML blocks", () => {
		const html = portableTextToHtml(
			[
				{
					_type: "htmlBlock",
					html: '<p onclick="steal()">Kept</p><script>steal()</script><style>b{}</style><iframe src="https://x"></iframe><a href="javascript:steal()">bad</a>',
				},
			],
			{ origin: ORIGIN },
		);
		expect(html).toContain("<p>Kept</p>");
		expect(html).not.toContain("onclick");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<style");
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("javascript:");
	});

	it("formats code blocks and plain breaks", () => {
		expect(portableTextToHtml([{ _type: "code", code: "a < b", language: "js" }], { origin: ORIGIN })).toBe(
			'<pre><code class="language-js">a &lt; b</code></pre>',
		);
		expect(portableTextToHtml([{ _type: "break" }], { origin: ORIGIN })).toBe("<hr />");
	});

	it("skips block types it does not know instead of guessing", () => {
		expect(portableTextToHtml([{ _type: "mystery", html: "<b>hi</b>" }], { origin: ORIGIN })).toBe(
			"",
		);
		expect(portableTextToHtml("not an array", { origin: ORIGIN })).toBe("");
	});
});

describe("portableTextToPlainText", () => {
	it("joins block text with blank lines and ignores markup", () => {
		const text = portableTextToPlainText([
			paragraph("One."),
			{ _type: "code", code: "let a = 1" },
			paragraph("Two."),
			{ _type: "htmlBlock", html: "<p>raw</p>" },
		]);
		expect(text).toBe("One.\n\nlet a = 1\n\nTwo.");
	});
});

describe("escapeHtml", () => {
	it("escapes the five dangerous characters", () => {
		expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
	});
});
