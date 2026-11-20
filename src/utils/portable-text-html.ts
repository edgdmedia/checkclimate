/**
 * Portable Text → HTML, for feeds and anything else that needs a string.
 *
 * The page renders the same content with EmDash's `PortableText` component;
 * RSS needs markup inline, so this is a small serializer for the shapes
 * EmDash actually produces (see `emdash/src/content/converters`):
 *
 * - text blocks: `{_type:"block", style, children, markDefs, listItem, level}`
 *   with `{_type:"span", text, marks:[key|name]}` children
 * - media: `{_type:"image", asset:{_ref,url}, alt, caption}`, `gallery`,
 *   `video`, `iframe`, `code`, `htmlBlock`, `break`
 * - links: a `markDefs` entry `{_key,_type:"link",href,blank}` referenced by
 *   the span's `marks`
 *
 * It escapes everything it does not explicitly render, drops `javascript:` and
 * friends, and strips `script`/`style`/`iframe`/event handlers out of imported
 * HTML blocks — a feed reader is not a sandbox we control.
 */

type Node = Record<string, unknown>;

interface Options {
	/** Absolute origin, for media URLs and link targets. */
	origin: string;
	/** Feed readers get absolute links; on-page anchors stay relative. */
	absoluteLinks?: boolean;
}

const STYLES: Record<string, string> = {
	h1: "h2", // h1 belongs to the page, not the body
	h2: "h2",
	h3: "h3",
	h4: "h4",
	h5: "h5",
	h6: "h6",
	blockquote: "blockquote",
	normal: "p",
};

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function safeHref(href: string, options: Options): string | null {
	if (href.startsWith("mailto:") || href.startsWith("tel:")) return href;
	if (href.startsWith("#")) return href;
	if (href.startsWith("/")) {
		return options.absoluteLinks ? new URL(href, options.origin).toString() : href;
	}
	return /^https?:\/\//i.test(href) ? href : null;
}

function asArray(value: unknown): Node[] {
	return Array.isArray(value) ? (value as Node[]) : [];
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The block's link definitions, keyed by `_key`, as EmDash stores them. */
function markDefs(block: Node): Map<string, Node> {
	const defs = new Map<string, Node>();
	for (const def of asArray(block.markDefs)) {
		const key = textOf(def._key);
		if (key) defs.set(key, def);
	}
	return defs;
}

function anchor(inner: string, href: string, blank: boolean): string {
	const rel = blank ? ' rel="noopener noreferrer"' : "";
	return `<a href="${escapeHtml(href)}"${blank ? ' target="_blank"' : ""}${rel}>${inner}</a>`;
}

function spanHtml(span: Node, defs: Map<string, Node>, options: Options): string {
	let html = escapeHtml(textOf(span.text));
	if (!html) return "";

	for (const mark of asArray(span.marks).length ? (span.marks as unknown[]) : []) {
		const name = typeof mark === "string" ? mark : "";
		if (!name) continue;

		const definition = defs.get(name);
		if (definition?._type === "link") {
			const href = safeHref(textOf(definition.href), options);
			// A link we cannot vouch for still shows its text, without the href.
			if (href) html = anchor(html, href, definition.blank === true);
			continue;
		}

		switch (name) {
			case "strong":
				html = `<strong>${html}</strong>`;
				break;
			case "em":
				html = `<em>${html}</em>`;
				break;
			case "code":
				html = `<code>${html}</code>`;
				break;
			case "underline":
				html = `<u>${html}</u>`;
				break;
			case "strike-through":
			case "strike":
				html = `<s>${html}</s>`;
				break;
			case "subscript":
				html = `<sub>${html}</sub>`;
				break;
			case "superscript":
				html = `<sup>${html}</sup>`;
				break;
			default:
				break;
		}
	}
	return html;
}

function inlineHtml(block: Node, options: Options): string {
	const defs = markDefs(block);
	return asArray(block.children)
		.map((child) => (child._type === "span" ? spanHtml(child, defs, options) : ""))
		.join("");
}

/** Absolute URL for an EmDash image, from `asset.url` then `asset._ref`. */
function imageSrc(block: Node, options: Options): string | null {
	const asset = (block.asset ?? {}) as Node;
	const candidates = [textOf(asset.url), textOf(asset._ref), textOf(block.src)];
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (/^https?:\/\//i.test(candidate)) return candidate;
		if (candidate.startsWith("/")) return new URL(candidate, options.origin).toString();
		// A bare storage key: EmDash's media file route serves it.
		return new URL(
			`/_emdash/api/media/file/${candidate.split("/").map(encodeURIComponent).join("/")}`,
			options.origin,
		).toString();
	}
	return null;
}

function figureHtml(block: Node, options: Options): string {
	const src = imageSrc(block, options);
	if (!src) return "";
	const alt = escapeHtml(textOf(block.alt));
	const caption = textOf(block.caption) ? `<figcaption>${escapeHtml(textOf(block.caption))}</figcaption>` : "";
	return `<figure><img src="${escapeHtml(src)}" alt="${alt}" />${caption}</figure>`;
}

/** Drops anything that could run in a reader that ignores feed sandboxing. */
function cleanImportedHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
		.replace(/<object[\s\S]*?<\/object>/gi, "")
		.replace(/<embed[^>]*>/gi, "")
		.replace(/\son\w+="[^"]*"/gi, "")
		.replace(/\son\w+'=[^']*'/gi, "")
		.replace(/(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, "");
}

function linkedBlock(block: Node, options: Options, fallbackLabel: string): string {
	const href = safeHref(textOf(block.src ?? block.url ?? block.source), options);
	if (!href) return "";
	const label = textOf(block.title) || textOf(block.caption) || fallbackLabel || href;
	return `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;
}

function blockHtml(block: Node, options: Options): string {
	switch (String(block._type ?? "")) {
		case "block": {
			const inner = inlineHtml(block, options);
			if (!inner) return "";
			const style = STYLES[textOf(block.style)] ?? "p";
			return `<${style}>${inner}</${style}>`;
		}
		case "image":
			return figureHtml(block, options);
		case "gallery": {
			const figures = asArray(block.images)
				.map((image) => figureHtml(image, options))
				.filter(Boolean);
			return figures.length > 0 ? `<div class="gallery">${figures.join("")}</div>` : "";
		}
		case "code": {
			const code = textOf(block.code);
			if (!code) return "";
			const language = textOf(block.language);
			return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code)}</code></pre>`;
		}
		case "htmlBlock":
			return cleanImportedHtml(textOf(block.html ?? block.value));
		case "break":
			return "<hr />";
		case "video":
		case "iframe":
		case "embed":
			return linkedBlock(block, options, textOf(block.title));
		case "file": {
			const href = imageSrc(block, options);
			if (!href) return "";
			const label = textOf(block.filename) || "Download the file";
			return `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;
		}
		case "pullquote":
			return `<blockquote>${inlineHtml(block, options)}</blockquote>`;
		default:
			// Unknown or plugin block types are skipped: a feed must not guess.
			return "";
	}
}

/**
 * Serialises a Portable Text value to HTML.
 *
 * List items are consecutive `listItem` blocks; `level` nests them, matching
 * the way EmDash flattens nested lists into the block array.
 */
export function portableTextToHtml(value: unknown, options: Options): string {
	if (!Array.isArray(value)) return "";
	const blocks = value as Node[];
	const parts: string[] = [];
	let openLists: Array<{ kind: string; tag: string }> = [];

	const closeLists = (toDepth = 0) => {
		while (openLists.length > toDepth) {
			const list = openLists.pop();
			if (list) parts.push(`</${list.tag}>`);
		}
	};

	for (const block of blocks) {
		const kind = textOf(block.listItem);
		if (kind) {
			const tag = kind === "number" ? "ol" : "ul";
			const level = Math.max(1, Number(block.level) || 1);
			// Nest one list per level, closing any deeper ones first.
			while (openLists.length > level) closeLists(level);
			while (openLists.length < level) {
				openLists.push({ kind, tag });
				parts.push(`<${tag}>`);
			}
			if (openLists[level - 1]?.tag !== tag) {
				closeLists(level - 1);
				openLists.push({ kind, tag });
				parts.push(`<${tag}>`);
			}
			parts.push(`<li>${inlineHtml(block, options)}</li>`);
			continue;
		}

		closeLists();
		const html = blockHtml(block, options);
		if (html) parts.push(html);
	}
	closeLists();

	return parts.join("\n");
}

/** Plain text of a Portable Text value, for meta descriptions and summaries. */
export function portableTextToPlainText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return (value as Node[])
		.map((block) => {
			const type = String(block._type ?? "");
			if (type === "block" || type === "pullquote") {
				return asArray(block.children)
					.map((child) => textOf(child.text))
					.join("");
			}
			if (type === "code") return textOf(block.code);
			if (type === "htmlBlock") return "";
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}
