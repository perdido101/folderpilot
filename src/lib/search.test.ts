import { describe, expect, it } from "vitest";
import type { FileRecord } from "./db";
import { cosine, keywordSearch, norm, parseQuery } from "./search";

let id = 1;
const f = (p: Partial<FileRecord>): FileRecord => ({ id: id++, rootId: 1, path: p.name ?? "x", name: "x", ext: "pdf", kind: "document", size: 1, mtime: new Date(2025, 1, 1).getTime(), status: "analyzed", flags: [], tags: [], ...p });

describe("search", () => {
  const nda = f({ name: "NDA Alpha Ltd - signed.pdf", path: "Clients/Alpha Ltd/NDA Alpha Ltd - signed.pdf", category: "NDAs", textExcerpt: "MUTUAL NON-DISCLOSURE AGREEMENT Between Alpha Ltd" });
  const ndaOld = f({ name: "NDA Alpha Ltd.pdf", mtime: new Date(2023, 1, 1).getTime() });
  const inv = f({ name: "Τιμολόγιο 1001.pdf", category: "Invoices", client: "Beta SA" });
  const photo = f({ name: "IMG_1.jpg", ext: "jpg", kind: "image", caption: "Sunset over hills in Naxos" });

  it("parses natural queries", () => {
    expect(parseQuery("the signed NDA with Alpha from 2025")).toEqual({ terms: ["signed", "nda", "alpha"], year: 2025 });
    expect(parseQuery("photos of Naxos")).toEqual({ terms: ["naxo"], kind: "image" });
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
