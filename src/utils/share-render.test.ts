import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { shareLayout, type ShareInput } from "./share-card";
import { renderCard, textLayer } from "./share-render";

const input: ShareInput = {
	claim: "Lagos State says it has planted 1.5 million mangrove seedlings in two years, and that missing coastal forests caused the 2024 floods.",
	claimSource: "Post by the Lagos State Government, 12 April 2025",
	verdict: "Partly true",
	summary: "The seedlings are real. The link to the floods is not supported by the evidence cited.",
	host: "checkclimate.africa",
};

describe("textLayer", () => {
	it("draws every line, including one that sits on the baseline exactly", () => {
		const layout = shareLayout("wide", input);
		const svg = textLayer(layout, layout.ops);
		expect(svg).not.toBeNull();
		const text = svg!.toString();
		// opentype.js 2.0.0 rounds to `NaN` when a path coordinate is asked to
		// be rounded onto the baseline offset; a path containing NaN renders as
		// nothing, so a card can silently lose its headline.
		expect(text).not.toContain("NaN");
		expect(text).toContain("fill-opacity="); // the soft-white summary line
		const paths = text.match(/<path /g) ?? [];
		expect(paths.length).toBe(layout.ops.filter((op) => op.kind === "text").length);
	});

	it("returns null when there is no text to draw", () => {
		const layout = shareLayout("wide", input);
		expect(textLayer(layout, layout.ops.filter((op) => op.kind === "asset"))).toBeNull();
	});
});

describe("renderCard", () => {
	for (const [format, size] of [
		["wide", { width: 1200, height: 630 }],
		["portrait", { width: 1080, height: 1350 }],
	] as const) {
		it(`paints the ${format} card at ${size.width}×${size.height}`, async () => {
			const png = await renderCard({
				format,
				layout: shareLayout(format, input),
				photo: null,
			});
			const meta = await sharp(png).metadata();
			expect(meta.format).toBe("png");
			expect(meta.width).toBe(size.width);
			expect(meta.height).toBe(size.height);
		});
	}

	it("lays a photo under the shade", async () => {
		const photo = await sharp({
			create: { width: 900, height: 500, channels: 3, background: { r: 200, g: 40, b: 40 } },
		})
			.png()
			.toBuffer();
		const plain = await renderCard({ format: "wide", layout: shareLayout("wide", input), photo: null });
		const withPhoto = await renderCard({ format: "wide", layout: shareLayout("wide", input), photo });
		// The card is mostly dark green; a red photo bleeding through at 35%
		// must raise the average red channel without flipping the whole image.
		const mean = async (buffer: Buffer) => {
			const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
			let sum = 0;
			for (let i = 0; i < data.length; i += info.channels) sum += data[i];
			return sum / (data.length / info.channels);
		};
		expect(await mean(withPhoto)).toBeGreaterThan(await mean(plain));
	});
});
