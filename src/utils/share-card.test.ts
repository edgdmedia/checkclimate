import { describe, expect, it } from "vitest";
import { shareLayout, stampColour, wrapText } from "./share-card";

describe("wrapText", () => {
	it("wraps on word boundaries within the limit", () => {
		const lines = wrapText("Snow fell in parts of Nigeria including Jos and Lagos", 20, 5);
		expect(lines.every((line) => line.length <= 20)).toBe(true);
		expect(lines.join(" ")).toBe("Snow fell in parts of Nigeria including Jos and Lagos");
	});

	it("cuts to maxLines with an ellipsis", () => {
		const lines = wrapText("one two three four five six seven eight nine ten", 10, 2);
		expect(lines).toHaveLength(2);
		expect(lines[1]!.endsWith("…")).toBe(true);
		expect(lines[1]!.length).toBeLessThanOrEqual(10);
	});

	it("hard-splits a word longer than a line", () => {
		expect(wrapText("aaaaaaaaaaaa", 5, 5)).toEqual(["aaaaa", "aaaaa", "aa"]);
	});
});

describe("stampColour", () => {
	it.each([
		["False", "red"],
		["Misleading", "amber"],
		["False context", "amber"],
		["Partly true", "amber"],
		["True", "green"],
		["Unproven", "grey"],
	])("%s → %s", (verdict, colour) => expect(stampColour(verdict)).toBe(colour));
});

describe("shareLayout", () => {
	const input = {
		claim: "Snow fell in parts of Nigeria, including Jos, Lagos, Enugu, Ikorodu and Ijebu Ode.",
		claimSource: "Posts on Facebook, TikTok, Instagram, X and YouTube",
		verdict: "False",
		summary: "The social media claim that snowfall occurred in Nigeria is false.",
		host: "checkclimate.africa",
	};

	for (const format of ["wide", "portrait"] as const) {
		it(`keeps every ${format} element inside the canvas`, () => {
			const layout = shareLayout(format, input);
			for (const op of layout.ops) {
				expect(op.left).toBeGreaterThanOrEqual(0);
				expect(op.top).toBeGreaterThanOrEqual(0);
				expect(op.top).toBeLessThan(layout.height - 20);
			}
			expect(layout.ops.some((op) => op.kind === "asset" && op.path.includes("stamp-red"))).toBe(true);
		});
	}

	it("keeps a very long claim to three lines on the wide card", () => {
		const layout = shareLayout("wide", { ...input, claim: "word ".repeat(120) });
		const claimLines = layout.ops.filter((op) => op.kind === "text" && op.weight === 900 && op.color === "#ffffff" && op.text !== "FALSE");
		expect(claimLines.length).toBeLessThanOrEqual(3);
	});
});
