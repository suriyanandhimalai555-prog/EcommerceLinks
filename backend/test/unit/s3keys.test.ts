import { describe, expect, it } from "vitest";
import { buildKey, kycKeyRe, PRODUCT_KEY_RE } from "../../src/lib/s3.js";

describe("buildKey", () => {
	it("derives the extension from the content type, never the file name", () => {
		expect(buildKey("products", "image/jpeg")).toMatch(PRODUCT_KEY_RE);
		expect(buildKey("products", "image/png")).toMatch(/\.png$/);
		expect(buildKey("products", "image/webp")).toMatch(/\.webp$/);
	});

	it("rejects unsupported content types with a 400", () => {
		expect(() => buildKey("products", "image/gif")).toThrowError(
			expect.objectContaining({ statusCode: 400 }),
		);
		expect(() => buildKey("products", "application/pdf")).toThrowError(
			expect.objectContaining({ statusCode: 400 }),
		);
	});

	it("scopes KYC keys to the member folder", () => {
		const key = buildKey("kyc/42", "image/jpeg");
		expect(key).toMatch(kycKeyRe("42"));
	});
});

describe("PRODUCT_KEY_RE", () => {
	it("accepts only uuid-named images under products/", () => {
		expect(
			PRODUCT_KEY_RE.test(
				"products/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
			),
		).toBe(true);
	});

	it("rejects foreign prefixes, traversal and non-uuid names", () => {
		for (const bad of [
			"kyc/1/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
			"products/../kyc/1/x.jpg",
			"products/evil.jpg",
			"products/0f8fad5b-d9cb-469f-a165-70867728950e.svg",
			"products/0f8fad5b-d9cb-469f-a165-70867728950e.jpg.exe",
			"other/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
		]) {
			expect(PRODUCT_KEY_RE.test(bad)).toBe(false);
		}
	});
});

describe("kycKeyRe", () => {
	const re = kycKeyRe("7");

	it("accepts the member's own folder only", () => {
		expect(re.test("kyc/7/0f8fad5b-d9cb-469f-a165-70867728950e.png")).toBe(
			true,
		);
	});

	it("rejects other members' folders and traversal", () => {
		for (const bad of [
			"kyc/8/0f8fad5b-d9cb-469f-a165-70867728950e.png",
			"kyc/77/0f8fad5b-d9cb-469f-a165-70867728950e.png",
			"kyc/7/../8/0f8fad5b-d9cb-469f-a165-70867728950e.png",
			"products/0f8fad5b-d9cb-469f-a165-70867728950e.png",
			"kyc/7/plain.png",
		]) {
			expect(re.test(bad)).toBe(false);
		}
	});
});
