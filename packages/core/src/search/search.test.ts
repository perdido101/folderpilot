import { describe, expect, it } from "vitest";
import { cosine, embedText, EmbeddingSizeError, hashText, norm, parseQuery, removeChip, rrf, termVariants, toDims } from "./index";

const now = new Date("2026-10-15T12:00:00Z");

describe("parseQuery", () => {
  it("splits words from recognized filters and reports chips", () => {
    const q = parseQuery("Invoices from Alpha 2025 PDFs", now);
    expect(q.terms).toEqual(["invoices", "alpha"]);
    expect(q).toMatchObject({ ext: "pdf", from: "2025-01-01", to: "2026-01-01" });
    expect(q.chips.map((c) => [c.type, c.value, c.raw])).toEqual([
      ["year", "2025", "2025"],
      ["ext", "pdf", "PDFs"],
    ]);
  });

  it("understands kinds, flags and relative dates", () => {
    expect(parseQuery("screenshots last month", now)).toMatchObject({ flag: "screenshot", from: "2026-09-01", to: "2026-10-01", terms: [] });
    expect(parseQuery("photos this year", now)).toMatchObject({ kind: "image", from: "2026-01-01", to: "2027-01-01" });
    expect(parseQuery("duplicates today", now)).toMatchObject({ flag: "duplicate", from: "2026-10-15", to: "2026-10-16" });
    expect(parseQuery("notes last week", now)).toMatchObject({ terms: ["notes"], from: "2026-10-05", to: "2026-10-12" });
  });

  it("ignores accents, case and stopwords", () => {
    expect(norm("Café Τιμολόγιο")).toBe("cafe τιμολογιο");
    expect(parseQuery("Show me the CAFÉ menus", now).terms).toEqual(["cafe", "menus"]);
  });

  it("removes a chip's words from the query", () => {
    const q = "screenshots last month from Alpha";
    const chip = parseQuery(q, now).chips.find((c) => c.type === "date")!;
    expect(removeChip(q, chip)).toBe("screenshots from Alpha");
  });
});

describe("ranking", () => {
  it("rrf favours items found by both lists and reports sources", () => {
    const fused = rrf([
      { name: "words", ids: ["a", "b", "c"] },
      { name: "meaning", ids: ["c", "d", "a"] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.sources).toEqual(["words", "meaning"]);
    expect(fused.find((f) => f.id === "d")!.sources).toEqual(["meaning"]);
  });

  it("toDims pads without changing cosine and refuses oversized vectors", () => {
    const a = [1, 2, 3];
    const b = [3, 2, 1];
    expect(cosine(toDims(a, 8), toDims(b, 8))).toBeCloseTo(cosine(a, b), 10);
    expect(toDims(a, 8)).toHaveLength(8);
    expect(() => toDims(new Array(1536).fill(0.1))).toThrow(EmbeddingSizeError);
  });

  it("embedText is stable and its hash changes only with the text", () => {
    const f = { name: "inv.pdf", category: "Invoices", client: "Alpha", tags: ["paid"], textExcerpt: "x".repeat(2000) };
    expect(embedText(f).length).toBeLessThan(700);
    expect(hashText(embedText(f))).toBe(hashText(embedText({ ...f })));
    expect(hashText(embedText(f))).not.toBe(hashText(embedText({ ...f, caption: "new" })));
  });
});

describe("termVariants", () => {
  it("folds simple English plurals and keeps the original first", () => {
    expect(termVariants("invoices")).toEqual(["invoices", "invoice"]);
    expect(termVariants("companies")).toEqual(["companies", "company"]);
    expect(termVariants("boxes")).toEqual(["boxes", "box"]);
    expect(termVariants("glass")).toEqual(["glass"]);
    expect(termVariants("bus")).toEqual(["bus"]);
    expect(termVariants("alpha")).toEqual(["alpha"]);
  });
});
