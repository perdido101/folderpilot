import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { AIProvider } from "@folderpilot/ai";
import { db, type FileRecord } from "./db";
import { buildEmbeddings, cosine, hybridSearch, keywordSearch, norm, parseQuery } from "./search";

let id = 1;
const f = (p: Partial<FileRecord>): FileRecord => ({ id: id++, rootId: 1, path: p.name ?? "x", name: "x", ext: "pdf", kind: "document", size: 1, mtime: new Date(2025, 1, 1).getTime(), status: "analyzed", flags: [], tags: [], ...p });

describe("search", () => {
  const nda = f({ name: "NDA Alpha Ltd - signed.pdf", path: "Clients/Alpha Ltd/NDA Alpha Ltd - signed.pdf", category: "NDAs", textExcerpt: "MUTUAL NON-DISCLOSURE AGREEMENT Between Alpha Ltd" });
  const ndaOld = f({ name: "NDA Alpha Ltd.pdf", mtime: new Date(2023, 1, 1).getTime() });
  const inv = f({ name: "Τιμολόγιο 1001.pdf", category: "Invoices", client: "Beta SA" });
  const photo = f({ name: "IMG_1.jpg", ext: "jpg", kind: "image", caption: "Sunset over hills in Naxos" });

  it("parses natural queries", () => {
    expect(parseQuery("the signed NDA with Alpha from 2025")).toMatchObject({ terms: ["signed", "nda", "alpha"], from: "2025-01-01", to: "2026-01-01" });
    expect(parseQuery("photos of Naxos")).toMatchObject({ terms: ["naxos"], kind: "image" });
  });

  it("finds the signed NDA with Alpha from 2025", () => {
    expect(keywordSearch([nda, ndaOld, inv, photo], "the signed NDA with Alpha from 2025").map((r) => r.file)).toEqual([nda]);
  });

  it("is accent-insensitive and searches captions/categories/clients", () => {
    expect(keywordSearch([nda, inv, photo], "τιμολογιο").map((r) => r.file)).toEqual([inv]);
    expect(keywordSearch([nda, inv, photo], "invoices beta").map((r) => r.file)).toEqual([inv]);
    expect(keywordSearch([nda, inv, photo], "sunset photos").map((r) => r.file)).toEqual([photo]);
  });

  it("returns nothing for an empty query and ranks name matches first", () => {
    expect(keywordSearch([nda], "  ")).toEqual([]);
    const byText = f({ name: "a.pdf", textExcerpt: "alpha" });
    expect(keywordSearch([byText, nda], "alpha")[0]!.file).toBe(nda);
  });

  it("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(norm("Ά")).toBe("α");
  });
});

describe("hybrid search on this device", () => {
  /** "bill" means "invoice". */
  const vec = (t: string) => [/bill|invoice|τιμολ/i.test(t) ? 1 : 0, /beach|sunset|holiday/i.test(t) ? 1 : 0, 0.01];
  const provider = { embed: async (texts: string[]) => texts.map(vec) } as unknown as AIProvider;

  it("merges words and meaning with RRF and reports where each hit came from", async () => {
    await Promise.all([db.files.clear(), db.embeddings.clear()]);
    const base = { rootId: 7, ext: "pdf", kind: "document" as const, size: 1, mtime: Date.parse("2026-03-01"), status: "analyzed" as const, flags: [], tags: [] };
    const inv = await db.files.add({ ...base, path: "invoice-1.pdf", name: "invoice-1.pdf", category: "Invoices" });
    const notes = await db.files.add({ ...base, path: "notes.txt", name: "notes.txt", ext: "txt", textExcerpt: "invoice reminder" });
    await db.files.add({ ...base, path: "beach.jpg", name: "beach.jpg", ext: "jpg", kind: "image", caption: "sunset" });
    expect(await buildEmbeddings(7, provider, "fake")).toBe(3);
    expect(await buildEmbeddings(7, provider, "fake")).toBe(0);
    const files = await db.files.toArray();

    const bill = await hybridSearch(7, files, "bill", { provider, model: "fake" });
    expect(bill.hits.map((h) => [h.file.name, h.sources.join("+")])).toEqual([
      ["invoice-1.pdf", "meaning"],
      ["notes.txt", "meaning"],
    ]);
    const invoice = await hybridSearch(7, files, "invoice", { provider, model: "fake" });
    expect(invoice.hits[0]).toMatchObject({ file: { id: inv }, sources: ["words", "meaning"] });
    expect(invoice.hits.map((h) => h.file.id)).toContain(notes);
    const holiday = await hybridSearch(7, files, "holiday photos", { provider, model: "fake" });
    expect(holiday.hits.map((h) => h.file.name)).toEqual(["beach.jpg"]);
    expect(holiday.parsed.chips.map((c) => c.value)).toEqual(["image"]);
    expect((await hybridSearch(7, files, "bill", {})).semantic).toBe("unavailable");
  });
});
