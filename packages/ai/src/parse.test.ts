import { describe, expect, it } from "vitest";
import { extractJson, parseInsight, sanitizeSuggestedName } from "./parse";

const valid = { category: "Invoices", tags: ["invoice", "alpha"], caption: "Invoice 1001 for Alpha Ltd.", suggestedName: "2024-03 Invoice 1001 - Alpha Ltd", client: "Alpha Ltd", confidence: 0.92, reason: "Header says INVOICE" };

describe("extractJson", () => {
  it("parses plain JSON", () => expect(extractJson(JSON.stringify(valid))).toEqual(valid));
  it("strips ```json fences", () => expect(extractJson("```json\n" + JSON.stringify(valid) + "\n```")).toEqual(valid));
  it("finds the object inside chatter", () => expect(extractJson(`Sure! Here you go: ${JSON.stringify(valid)} Hope that helps.`)).toEqual(valid));
  it("throws when there is no JSON", () => expect(() => extractJson("I can't tell.")).toThrow(/No JSON/));
});

describe("parseInsight", () => {
  it("accepts a valid insight", () => expect(parseInsight(JSON.stringify(valid))).toEqual(valid));

  it("normalizes loose model output", () => {
    const loose = { category: " Receipts ", tags: "Fuel, Car ,", caption: "Fuel receipt", suggested_name: "Fuel receipt 2024-05", confidence: "85", reason: 3 };
    expect(parseInsight(loose)).toEqual({ category: "Receipts", tags: ["fuel", "car"], caption: "Fuel receipt", suggestedName: "Fuel receipt 2024-05", client: null, confidence: 0.85, reason: "" });
  });

  it("rejects missing category and out-of-range confidence", () => {
    expect(() => parseInsight({ ...valid, category: "" })).toThrow();
    expect(() => parseInsight({ ...valid, category: undefined })).toThrow();
    expect(() => parseInsight({ ...valid, confidence: 7 })).toThrow();
    expect(() => parseInsight({ ...valid, confidence: "high" })).toThrow();
  });

  it("caps tags at 8", () => expect(parseInsight({ ...valid, tags: Array.from({ length: 12 }, (_, i) => `t${i}`) }).tags).toHaveLength(8));
});

describe("sanitizeSuggestedName", () => {
  it("keeps the original extension", () => expect(sanitizeSuggestedName("2024 Invoice", "scan001.PDF")).toBe("2024 Invoice.PDF"));
  it("doesn't double the extension", () => expect(sanitizeSuggestedName("Invoice.pdf", "a.pdf")).toBe("Invoice.pdf"));
  it("removes characters Windows forbids", () => expect(sanitizeSuggestedName('NDA: Alpha/Beta "final"?', "x.docx")).toBe("NDA AlphaBeta final.docx"));
  it("falls back to the original when empty", () => expect(sanitizeSuggestedName(" ?? ", "x.txt")).toBe("x.txt"));
});
