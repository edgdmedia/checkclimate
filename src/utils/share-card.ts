/**
 * Layout for the fact-check share cards (/share/<format>/<slug>.png).
 *
 * Pure: turns a fact check into a list of things to draw, with positions.
 * src/pages/share/[format]/[slug].png.ts hands the list to the Workers Images
 * binding, which has no text wrapping, so lines are broken here by an
 * estimated character width for Red Hat Display.
 */

export type ShareFormat = "wide" | "portrait";
export type FontWeight = 500 | 700 | 900;
export type StampColour = "red" | "amber" | "green" | "grey";

export interface ShareInput {
	claim: string;
	claimSource?: string | null;
	verdict: string;
	summary?: string | null;
	host: string;
}

export type DrawOp =
	| { kind: "asset"; path: string; left: number; top: number }
	| { kind: "text"; text: string; size: number; weight: FontWeight; color: string; left: number; top: number };

export interface ShareLayout {
	width: number;
	height: number;
	ops: DrawOp[];
}

export const SHARE_SIZES: Record<ShareFormat, { width: number; height: number }> = {
	wide: { width: 1200, height: 630 },
	portrait: { width: 1080, height: 1350 },
};

/** Average glyph width as a share of the font size (Red Hat Display). */
const GLYPH: Record<FontWeight, number> = { 500: 0.52, 700: 0.55, 900: 0.58 };

const WHITE = "#ffffff";
const SOFT = "rgba(255,255,255,0.78)";
const AMBER = "#f2b632";

export function stampColour(verdict: string): StampColour {
	switch (verdict.trim().toLowerCase()) {
		case "false":
			return "red";
		case "misleading":
		case "false context":
		case "partly true":
			return "amber";
		case "true":
			return "green";
		default:
			return "grey";
	}
}

/**
 * Greedy word wrap to `maxChars` per line, at most `maxLines` lines; the last
 * line ends with an ellipsis when text was cut. Single words longer than a
 * line are hard-split.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (let word of words) {
		while (word.length > maxChars) {
			if (line) lines.push(line);
			line = "";
			lines.push(word.slice(0, maxChars));
			word = word.slice(maxChars);
		}
		const next = line ? `${line} ${word}` : word;
		if (next.length <= maxChars) line = next;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	if (lines.length <= maxLines) return lines;

	const out = lines.slice(0, maxLines);
	let last = out[maxLines - 1]!;
	while (last.length + 1 > maxChars && /\s/.test(last)) last = last.replace(/\s*\S+$/, "");
	out[maxLines - 1] = `${last.replace(/[\s,.;:]+$/, "")}…`;
	return out;
}

function charsFor(width: number, size: number, weight: FontWeight): number {
	return Math.max(8, Math.floor(width / (size * GLYPH[weight])));
}

/** Fits text into `maxLines` by stepping the size down from `sizes[0]`. */
function fit(text: string, width: number, sizes: number[], weight: FontWeight, maxLines: number) {
	for (const size of sizes) {
		const lines = wrapText(text, charsFor(width, size, weight), maxLines + 1);
		if (lines.length <= maxLines) return { size, lines };
	}
	const size = sizes[sizes.length - 1]!;
	return { size, lines: wrapText(text, charsFor(width, size, weight), maxLines) };
}

function textBlock(
	ops: DrawOp[],
	lines: string[],
	opts: { size: number; weight: FontWeight; color: string; left: number; top: number; lineHeight: number },
): number {
	lines.forEach((text, index) => {
		ops.push({ kind: "text", text, size: opts.size, weight: opts.weight, color: opts.color, left: opts.left, top: Math.round(opts.top + index * opts.lineHeight) });
	});
	return opts.top + lines.length * opts.lineHeight;
}

export function shareLayout(format: ShareFormat, input: ShareInput): ShareLayout {
	const { width, height } = SHARE_SIZES[format];
	const ops: DrawOp[] = [];
	const colour = stampColour(input.verdict);
	const stampInk = colour === "amber" ? "#1d1606" : WHITE;
	const verdictText = input.verdict.toUpperCase();

	if (format === "wide") {
		const m = 64;
		const inner = width - m * 2;
		ops.push({ kind: "asset", path: "/share/logo-wide.png", left: m, top: 44 });
		ops.push({ kind: "text", text: "FACT CHECK", size: 22, weight: 900, color: AMBER, left: width - m - 150, top: 62 });

		let y = 150;
		ops.push({ kind: "text", text: "THE CLAIM", size: 18, weight: 700, color: AMBER, left: m, top: y });
		y += 32;
		const claim = fit(`“${input.claim}”`, inner, [44, 40, 36, 32], 900, 3);
		y = textBlock(ops, claim.lines, { size: claim.size, weight: 900, color: WHITE, left: m, top: y, lineHeight: Math.round(claim.size * 1.18) });

		y += 28;
		ops.push({ kind: "asset", path: `/share/stamp-${colour}-wide.png`, left: m, top: y });
		const stampSize = verdictText.length > 11 ? 30 : 38;
		ops.push({ kind: "text", text: verdictText, size: stampSize, weight: 900, color: stampInk, left: m + 26, top: Math.round(y + (84 - stampSize * 1.2) / 2) + 8 });

		if (input.summary) {
			const left = m + 440 + 28;
			const summary = wrapText(input.summary, charsFor(width - m - left, 21, 500), 3);
			textBlock(ops, summary, { size: 21, weight: 500, color: SOFT, left, top: y - 2, lineHeight: 29 });
		}

		ops.push({ kind: "text", text: `Read the full fact check at ${input.host}`, size: 21, weight: 700, color: WHITE, left: m, top: height - 62 });
		return { width, height, ops };
	}

	const m = 80;
	const inner = width - m * 2;
	ops.push({ kind: "asset", path: "/share/logo-portrait.png", left: m, top: 76 });

	let y = 236;
	ops.push({ kind: "text", text: "FACT CHECK", size: 30, weight: 900, color: AMBER, left: m, top: y });
	y += 74;
	ops.push({ kind: "text", text: "THE CLAIM", size: 24, weight: 700, color: AMBER, left: m, top: y });
	y += 42;
	const claim = fit(`“${input.claim}”`, inner, [62, 56, 50, 44], 900, 6);
	y = textBlock(ops, claim.lines, { size: claim.size, weight: 900, color: WHITE, left: m, top: y, lineHeight: Math.round(claim.size * 1.16) });

	if (input.claimSource) {
		y += 16;
		const source = wrapText(input.claimSource, charsFor(inner, 26, 500), 2);
		y = textBlock(ops, source, { size: 26, weight: 500, color: SOFT, left: m, top: y, lineHeight: 36 });
	}

	y += 44;
	ops.push({ kind: "asset", path: `/share/stamp-${colour}-portrait.png`, left: m, top: y });
	const stampSize = verdictText.length > 11 ? 40 : 50;
	ops.push({ kind: "text", text: verdictText, size: stampSize, weight: 900, color: stampInk, left: m + 32, top: Math.round(y + (104 - stampSize * 1.2) / 2) + 12 });
	y += 104 + 34;

	if (input.summary) {
		const room = Math.max(1, Math.floor((height - 150 - y) / 42));
		const summary = wrapText(input.summary, charsFor(inner, 30, 500), Math.min(5, room));
		textBlock(ops, summary, { size: 30, weight: 500, color: WHITE, left: m, top: y, lineHeight: 42 });
	}

	ops.push({ kind: "text", text: `Read the full fact check at ${input.host}`, size: 28, weight: 700, color: AMBER, left: m, top: height - 96 });
	return { width, height, ops };
}
