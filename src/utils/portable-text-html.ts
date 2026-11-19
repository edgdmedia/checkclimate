import { imageUrl } from "./content";

/**
 * Portable Text → HTML, for feeds and meta descriptions.
 *
 * The page renders the same content with EmDash's `PortableText` component;
 * feeds need a string, so this is a small serializer for the block types the
 * site produces. It escapes everything it does not explicitly render, and it
 * never copies `<script>` or `<style>` out of an imported HTML block.
 */

type Node = Record<string, unknown>;

interface Options {
	/** Absolute origin, for media URLs and link targets. */
	origin: string;
	/** Feed readers get absolute links; inline anchors stay relative on page. */
	absoluteLinks?: boolean;
}

const STYLE_TAGS: Record<string, string> = {
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
	if (/^https?:\/\//i.test(href)) return href;
	return null;
}

function spanText(children: unknown, options: Options): string {
	if (!Array.isArray(children)) return "";
	return children
		.map((child) => {
			const node = child as Node;
			if (node._type !== "span") return "";
			const text = escapeHtml(String(node.text ?? ""));
			const marks = (node.markDefs ?? node.marks) as unknown;
			const names = Array.isArray(node.marks) ? (node.marks as string[]) : [];
			if (names.length === 0) return text;

			let html = text;
			const defs = Array.isArray(marks) ? [] : ((node.markDefs as Node[]) ?? []);
			for (const name of names) {
				const definition = defs.find((def) => def._key === name) as Node | undefined;
				if (definition && definition._type === "link") {
					const href = safeHref(String(definition.href ?? ""), options);
					if (href) {
						html = `<a href="${escapeHtml(href)}"${
							options.absoluteLinks ? "" : ' rel="nofollow"'
						}>${html}</a>`;
					}
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
					case "sub":
						html = `<sub>${html}</sub>`;
						break;
					case "sup":
						html = `<sup>${html}</sup>`;
						break;
					default:
						break;
				}
			}
			return html;
		})
		.join("");
}

function listItems(blocks: Node[], options: Options): { html: string; kind: string } | null {
	const kind = blocks.some((block) => block.list === "number") ? "number" : "bullet";
	const items = blocks
		.filter((block) => block.list === kind)
		.map((block) => `<li>${spanText(block.children, options)}</li>`)
		.join("");
	if (!items) return null;
	return {
		html: kind === "number" ? `<ol>${items}</ol>` : `<ul>${items}</ul>`,
		kind,
	};
}

/** Drops tags that could run code in a reader that ignores feed sandboxing. */
function cleanImportedHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
		.replace(/\son\w+="[^"]*"/gi, "");
}

function blockHtml(block: Node, options: Options): string {
	const type = String(block._type ?? "");

	if (type === "block") {
		const style = String(block.style ?? "normal");
		const inner = spanText(block.children, options);
		if (!inner) return "";
		if (block.list) return inner;
		return `<${STYLE_TAGS[style] ?? "p"}>${inner}</${STYLE_TAGS[style] ?? "p"}>`;
	}

	if (type === "image") {
		const src = imageUrl(options.origin, block.asset ?? block);
		if (!src) return "";
		const alt = escapeHtml(String(block.alt ?? ""));
		const caption = block.caption ? `<figcaption>${escapeHtml(String(block.caption))}</figcaption>` : "";
		return `<figure><img src="${escapeHtml(src)}" alt="${alt}" />${caption}</figure>`;
	}

	if (type === "embed" || type === "iframe" || type === "video") {
		const url = String(block.url ?? block.src ?? block.source ?? "");
		const href = safeHref(url, options);
		if (!href) return "";
		const label = escapeHtml(String(block.title ?? block.caption ?? href));
		return `<p><a href="${escapeHtml(href)}">${label}</a></p>`;
	}

	if (type === "pullquote") {
		const text = spanText(block.children ?? block.text, options) || escapeHtml(String(block.text ?? ""));
		return `<blockquote>${text}</blockquote>`;
	}

	if (type === "code") {
		return `<pre><code>${escapeHtml(String(block.code ?? ""))}</code></pre>`;
	}

	if (type === "htmlBlock") {
		return cleanImportedHtml(String(block.html ?? block.value ?? ""));
	}

	if (type === "break") return "<hr />";

	if (type === "file") {
		const url = imageUrl(options.origin, block.asset ?? block);
		if (!url) return "";
		return `<p><a href="${escapeHtml(url)}">${escapeHtml(String(block.filename ?? "Download the file"))}</a></p>`;
	}

	return "";
}

/** Serialises a Portable Text value to HTML. Unknown blocks are skipped. */
export function portableTextToHtml(
	value: unknown,
	options: Options,
): string {
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	let pendingList: Node[] = [];

	const flushList = () => {
		if (pendingList.length === 0) return;
		const list = listItems(pendingList, options);
		if (list) parts.push(list.html);
		pendingList = [];
	};

	for (const raw of value as Node[]) {
		if (raw?.list) {
			pendingList.push(raw);
			continue;
		}
		flushList();
		const html = blockHtml(raw, options);
		if (html) parts.push(html);
	}
	flushList();
	return parts.join("\n");
}

/** Plain text of a Portable Text value, for meta descriptions and summaries. */
export function portableTextToPlainText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return (value as Node[])
		.map((block) => {
			const children = block.children as Node[] | undefined;
			if (Array.isArray(children)) {
				return children
					.map((child) => String(child.text ?? ""))
					.join("");
			}
			if (typeof block.text === "string") return block.text;
			if (typeof block.code === "string") return block.code;
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}
