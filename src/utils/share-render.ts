/**
 * Paints a fact-check share card to PNG.
 *
 * The old painter was the Workers Images binding: `IMAGES.text()` for the
 * words, `IMAGES.input().transform/draw()` for the photo, stamps and the
 * 35%-opacity overlay, in rounds of ten because the service capped a chain.
 * That service does not exist off-Workers, so this module does the same job
 * with two libraries that do:
 *
 *   - `sharp` composites raster layers over the base image;
 *   - `opentype.js` turns each line of text into a filled glyph path, and the
 *     whole layer ships as one SVG.
 *
 * Glyph paths rather than SVG `<text>` means the card never depends on a font
 * being installed on the box, which is what made the Workers version reliable:
 * the only font data used is the Red Hat Display TTFs in `share/fonts/`, and
 * the card looks the same here as it did there.
 *
 * `src/utils/share-card.ts` stays pure — it still decides what to draw and
 * where, including the character-width wrapping — and the ops are handed over
 * in order. Layers are built in that order, so a stamp always sits under the
 * verdict drawn on it.
 */
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import opentype from "opentype.js";
import type { DrawOp, FontWeight, ShareLayout } from "./share-card";

/** How much of the photo shows through before the shade goes on top. */
export const PHOTO_OPACITY = 0.35;

/**
 * Files are read relative to the process's working directory, which is the
 * checkout on the box (`WorkingDirectory=` in systemd) and the project root in
 * dev — the same assumption `DATABASE_PATH` and the media directory make.
 */
function fromRoot(path: string): string {
	const clean = path.replace(/^\/+/, "");
	const full = normalize(join(process.cwd(), clean));
	if (!full.startsWith(normalize(process.cwd()))) throw new Error(`outside the project: ${path}`);
	return full;
}

const fileCache = new Map<string, Buffer>();
/** Bytes of a repo file, read once and kept for the life of the process. */
export function repoFile(path: string): Buffer {
	let bytes = fileCache.get(path);
	if (!bytes) {
		bytes = readFileSync(fromRoot(path));
		fileCache.set(path, bytes);
	}
	return bytes;
}

/**
 * A file the site serves from `public/`, addressed by its site path:
 * `/share/logo-wide.png` is `public/share/logo-wide.png`. On Workers these
 * came out of the ASSETS binding; here they are the same committed files.
 */
function siteFile(path: string): Buffer {
	return repoFile(join("public", path.replace(/^\/+/, "")));
}

const fonts = new Map<FontWeight, opentype.Font>();
function font(weight: FontWeight): opentype.Font {
	let loaded = fonts.get(weight);
	if (!loaded) {
		const data = repoFile(`share/fonts/red-hat-display-${weight}.ttf`);
		// opentype.js wants an ArrayBuffer that starts at offset 0.
		loaded = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
		fonts.set(weight, loaded);
	}
	return loaded;
}

/**
 * A `DrawOp`'s `top` is where the block of text begins; `opentype` places a
 * baseline. The Workers renderer anchored the top of the capital letters at
 * `top`, so the baseline sits exactly one cap height below it. The cap height
 * is measured from the font ('H' at 100 px), not guessed: 0.70 em for Red Hat
 * Display at every weight, while `ascender` is 1.018 em of headroom no glyph
 * on the card actually uses.
 */
const capHeights = new Map<FontWeight, number>();
function capHeight(weight: FontWeight): number {
	let ratio = capHeights.get(weight);
	if (ratio === undefined) {
		const box = font(weight).getPath("H", 0, 0, 100).getBoundingBox();
		ratio = -box.y1 / 100;
		capHeights.set(weight, ratio);
	}
	return ratio;
}

/**
 * One pixel of slack between the `top` in a `DrawOp` and the first row of ink.
 * The Workers renderer put the cap line there: measured on the live cards, an
 * 18 px label with `top: 150` painted rows 151-162 and a 21 px line with
 * `top: 568` painted 569-583, so the same offset keeps a re-rendered card from
 * creeping a pixel above the one people have already shared.
 */
const INK_SLOP = 1;

function baseline(top: number, size: number, weight: FontWeight): number {
	return top + INK_SLOP + size * capHeight(weight);
}

/** `rgba(255,255,255,0.78)` → what SVG accepts: a colour and an opacity. */
function fillOf(color: string): { fill: string; opacity?: string } {
	const rgba = color.match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i);
	if (!rgba) return { fill: color };
	return {
		fill: `rgb(${rgba[1]},${rgba[2]},${rgba[3]})`,
		opacity: String(Number(rgba[4])),
	};
}

/**
 * SVG path data for an opentype.js path.
 *
 * Handled here rather than with `path.toPathData()`: opentype.js 2.0.0 rounds
 * through a module-level cache keyed on the fractional part of a number, and
 * that cache can hand back a `NaN`, which silently deletes the glyph from the
 * raster. Three decimals of a finite coordinate is all a 1200 px card needs.
 */
type Command = { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number };

function pathData(source: { commands: unknown[] }): string {
	const n = (value: number | undefined): string =>
		typeof value === "number" && Number.isFinite(value) ? String(Number(value.toFixed(3))) : "0";
	let d = "";
	for (const raw of source.commands) {
		const command = raw as Command;
		switch (command.type) {
			case "M":
				d += `M${n(command.x)} ${n(command.y)}`;
				break;
			case "L":
				d += `L${n(command.x)} ${n(command.y)}`;
				break;
			case "Q":
				d += `Q${n(command.x1)} ${n(command.y1)} ${n(command.x)} ${n(command.y)}`;
				break;
			case "C":
				d += `C${n(command.x1)} ${n(command.y1)} ${n(command.x2)} ${n(command.y2)} ${n(command.x)} ${n(command.y)}`;
				break;
			case "Z":
				d += "Z";
				break;
		}
	}
	return d;
}

const escape = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One full-canvas SVG holding every line in `ops` as a glyph path.
 * Returns null when there is no text, so the caller skips the layer.
 */
export function textLayer(layout: ShareLayout, ops: DrawOp[]): Buffer | null {
	const paths: string[] = [];
	for (const op of ops) {
		if (op.kind !== "text" || op.text.trim() === "") continue;
		const loaded = font(op.weight);
		const data = pathData(loaded.getPath(op.text, op.left, baseline(op.top, op.size, op.weight), op.size));
		if (!data) continue;
		const { fill, opacity } = fillOf(op.color);
		paths.push(`<path d="${data}" fill="${escape(fill)}"${opacity ? ` fill-opacity="${opacity}"` : ""}/>`);
	}
	if (paths.length === 0) return null;
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}"`,
		` viewBox="0 0 ${layout.width} ${layout.height}">`,
		...paths,
		"</svg>",
	].join("");
	return Buffer.from(svg);
}

export interface CardInput {
	format: "wide" | "portrait";
	layout: ShareLayout;
	/** The post photo, already downloaded, or null for the plain base. */
	photo: Buffer | null;
}

/** The finished card as PNG bytes. */
export async function renderCard(input: CardInput): Promise<Buffer> {
	const sharp = (await import("sharp")).default;
	const { layout, photo } = input;

	const base = await sharp(siteFile(`/share/base-${input.format}.png`))
		.resize({ width: layout.width, height: layout.height, fit: "cover" })
		.png()
		.toBuffer();

	// Layers in draw order: photo, shade, then every stamp and its text.
	const layers: Array<{ input: Buffer; left: number; top: number; opacity?: number }> = [];

	if (photo) {
		layers.push({
			input: await sharp(photo).resize({ width: layout.width, height: layout.height, fit: "cover" }).removeAlpha().png().toBuffer(),
			left: 0,
			top: 0,
			// sharp takes 0-255 for an input with no alpha channel.
			opacity: Math.round(PHOTO_OPACITY * 255),
		});
	}

	layers.push({ input: siteFile(`/share/shade-${input.format}.png`), left: 0, top: 0 });

	// Consecutive text ops share one SVG layer; an asset always sits below the
	// text drawn after it, exactly as the old in-order chain did.
	const queue: DrawOp[] = [];
	const flushText = () => {
		const layer = textLayer(layout, queue);
		if (layer) layers.push({ input: layer, left: 0, top: 0 });
		queue.length = 0;
	};
	for (const op of layout.ops) {
		if (op.kind === "asset") {
			flushText();
			layers.push({ input: siteFile(op.path), left: op.left, top: op.top });
		} else {
			queue.push(op);
		}
	}
	flushText();

	return sharp(base).composite(layers).png().toBuffer();
}
