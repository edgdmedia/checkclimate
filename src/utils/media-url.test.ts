import { describe, expect, it } from "vitest";
import { edgeImageUrl, publicMediaUrl, storageKeyOf } from "./media-url";

const BASE = "https://media.checkclimate.africa";

describe("storageKeyOf", () => {
	it("reads the key from an imported media value's src", () => {
		expect(storageKeyOf({ provider: "external", id: "", src: "/_emdash/api/media/file/01M7WWTD6KYFA4NXARWFPVA8Z8.jpeg" })).toBe(
			"01M7WWTD6KYFA4NXARWFPVA8Z8.jpeg",
		);
	});

	it("prefers meta.storageKey on a media-library value", () => {
		expect(storageKeyOf({ id: "01ABC", meta: { storageKey: "claims/202611/x.png" } })).toBe("claims/202611/x.png");
	});

	it("accepts this site's absolute media URL and decodes the key", () => {
		expect(storageKeyOf("https://checkclimate.africa/_emdash/api/media/file/wp/a%20b.jpg")).toBe("wp/a b.jpg");
	});

	it("leaves external images and non-media paths alone", () => {
		expect(storageKeyOf("https://example.com/_emdash/api/media/file/x.jpg")).toBeNull();
		expect(storageKeyOf("/brand/logo.webp")).toBeNull();
		expect(storageKeyOf(null)).toBeNull();
	});
});

describe("media domain URLs", () => {
	const image = { src: "/_emdash/api/media/file/01M7WGGDAX8EWRQ6S9RA89P3DT.png" };

	it("links the original on the media domain", () => {
		expect(publicMediaUrl(image, BASE)).toBe(`${BASE}/01M7WGGDAX8EWRQ6S9RA89P3DT.png`);
	});

	it("builds one fixed-order edge transformation, cropping without enlarging", () => {
		expect(edgeImageUrl(image, { width: 640, height: 427 }, BASE)).toBe(
			`${BASE}/cdn-cgi/image/width=640,height=427,fit=crop,format=webp,onerror=redirect/01M7WGGDAX8EWRQ6S9RA89P3DT.png`,
		);
	});

	it("scales down when only a width is given", () => {
		expect(edgeImageUrl(image, { width: 1400, fit: "scale-down" }, BASE)).toBe(
			`${BASE}/cdn-cgi/image/width=1400,fit=scale-down,format=webp,onerror=redirect/01M7WGGDAX8EWRQ6S9RA89P3DT.png`,
		);
	});

	it("encodes each path segment of a nested key", () => {
		expect(publicMediaUrl({ meta: { storageKey: "claims/202611/a b.png" } }, BASE)).toBe(`${BASE}/claims/202611/a%20b.png`);
	});

	it("returns null without a media domain, so callers keep EmDash's route", () => {
		expect(publicMediaUrl(image, "")).toBeNull();
		expect(edgeImageUrl(image, { width: 640 }, "")).toBeNull();
	});
});
