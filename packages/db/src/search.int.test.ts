import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Embedder } from "@folderpilot/ai";
import { embedText, hashText, norm } from "@folderpilot/core";
import { createTestDatabase, type TestDatabase } from "./testing";
import { files, organizations, spaces } from "./schema";
import { searchFiles } from "./search";

let t: TestDatabase;
let spaceA: string;
let spaceB: string;

/** Deterministic "meaning": words hashed into 1024 buckets, with a few synonyms mapped to one concept. */
const SYNONYMS: Record<string, string> = { bill: "invoice", invoice: "invoice", invoices: "invoice", receipt: "invoice", beach: "sea", sea: "sea", holiday: "sea" };
function fakeVector(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  for (const w of norm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const concept = SYNONYMS[w];
    if (!concept) continue;
    let h = 7;
    for (const c of concept) h = (h * 31 + c.charCodeAt(0)) % 1024;
    v[h]! += 1;
  }
  return v;
}
const embedder = (model = "fake:words"): Embedder & { calls: number } => ({
  model,
  calls: 0,
  async embed(texts) {
    this.calls++;
    return texts.map(fakeVector);
  },
});

async function addFile(space: string, path: string, extra: Partial<typeof files.$inferInsert> = {}, org = "org_s") {
  const name = path.split("/").pop()!;
  const [row] = await t.db
    .insert(files)
    .values({ organizationId: org, spaceId: space, providerRef: `${space}:${path}`, path, name, ext: name.split(".").pop()!, size: 100, mtime: new Date("2026-03-10"), ...extra })
    .returning();
  // Embed like the worker does.
  const text = embedText({ name: row!.name, category: row!.category, client: row!.entities?.client, docType: row!.entities?.docType, caption: row!.caption, tags: row!.tags, textExcerpt: row!.textExcerpt });
  const vec = fakeVector(text);
  if (vec.some((x) => x !== 0)) await t.db.update(files).set({ embedding: vec, embeddingModel: "fake:words", embeddingHash: hashText(text) }).where(eq(files.id, row!.id));
  return row!;
}

beforeAll(async () => {
  t = await createTestDatabase("fp_search");
  await t.db.insert(organizations).values([
    { id: "org_s", name: "Search", slug: "search" },
    { id: "org_other", name: "Other", slug: "other-s" },
  ]);
  const [a, b, other] = await t.db
    .insert(spaces)
    .values([
      { organizationId: "org_s", name: "Office", mode: "private", adapterId: "local-server", rootRef: "/a" },
      { organizationId: "org_s", name: "Archive", mode: "private", adapterId: "local-server", rootRef: "/b" },
      { organizationId: "org_other", name: "Theirs", mode: "private", adapterId: "local-server", rootRef: "/c" },
    ])
    .returning();
  spaceA = a!.id;
  spaceB = b!.id;
  await addFile(spaceA, "Finance/Invoice 1001.pdf", { category: "Invoices", entities: { client: "Alpha Ltd", docType: "invoice" }, textExcerpt: "INVOICE 1001 Alpha Ltd total EUR 1,250" });
  await addFile(spaceA, "Finance/statement-march.pdf", { category: "Bank statements", textExcerpt: "Monthly statement; see invoice 1001 paid" });
  await addFile(spaceA, "Photos/beach.jpg", { category: "Photos", caption: "A sunny beach", flags: ["duplicate"], mtime: new Date("2025-07-01") });
  await addFile(spaceA, "Menus/Café Menu.docx", { category: "Notes", textExcerpt: "Crème brûlée" });
  await addFile(spaceB, "Old/invoice-2019.pdf", { category: "Invoices", entities: { client: "Beta GmbH" }, mtime: new Date("2019-05-01") });
  await addFile(spaceA, "Trash/invoice-deleted.pdf", { category: "Invoices", status: "trashed" });
  await addFile(other!.id, "invoice-secret.pdf", { category: "Invoices" }, "org_other");
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const names = (r: Awaited<ReturnType<typeof searchFiles>>) => r.hits.map((h) => h.file.name);

describe("hybrid search", () => {
  it("the trigger keeps the full-text document up to date", async () => {
    const [f] = await t.db.select().from(files).where(eq(files.name, "beach.jpg"));
    expect(f!.searchTsv).toContain("sunny");
    await t.db.update(files).set({ caption: "Seaside at dusk" }).where(eq(files.id, f!.id));
    const [g] = await t.db.select().from(files).where(eq(files.id, f!.id));
    expect(g!.searchTsv).toContain("dusk");
    expect(g!.searchTsv).not.toContain("sunny");
    await t.db.update(files).set({ caption: "A sunny beach" }).where(eq(files.id, f!.id));
  });

  it("ranks name matches above text matches, ignores accents and trashed files, and stays in the organization", async () => {
    const r = await searchFiles(t.db, "org_s", { q: "invoice" });
    expect(names(r)).toEqual(["Invoice 1001.pdf", "invoice-2019.pdf", "statement-march.pdf"]);
    expect(r.semantic).toBe("unavailable");
    expect(r.hits[0]!.sources).toEqual(["words"]);
    expect(names(await searchFiles(t.db, "org_s", { q: "cafe creme" }))).toEqual(["Café Menu.docx"]);
    expect(names(await searchFiles(t.db, "org_s", { q: "invoi" }))).toContain("Invoice 1001.pdf"); // prefix while typing
    expect(names(await searchFiles(t.db, "org_s", { q: "invoices alpha" }))).toEqual(["Invoice 1001.pdf"]); // plural finds singular
    expect(names(await searchFiles(t.db, "org_s", { q: "menus" }))).toEqual(["Café Menu.docx"]);
    expect(names(await searchFiles(t.db, "org_other", { q: "invoice" }))).toEqual(["invoice-secret.pdf"]);
  });

  it("returns a highlighted snippet for word matches", async () => {
    const r = await searchFiles(t.db, "org_s", { q: "statement paid" });
    expect(r.hits[0]!.snippet).toContain("[[paid]]");
  });

  it("applies filters from the query and from the caller", async () => {
    expect(names(await searchFiles(t.db, "org_s", { q: "invoice 2019" }))).toEqual(["invoice-2019.pdf"]);
    expect(names(await searchFiles(t.db, "org_s", { q: "invoice", filters: { spaceIds: [spaceA] } }))).toEqual(["Invoice 1001.pdf", "statement-march.pdf"]);
    expect(names(await searchFiles(t.db, "org_s", { q: "invoice", filters: { client: "alpha" } }))).toEqual(["Invoice 1001.pdf"]);
    expect(names(await searchFiles(t.db, "org_s", { q: "invoice", filters: { category: "invoices" } }))).toEqual(["Invoice 1001.pdf", "invoice-2019.pdf"]);
    expect(names(await searchFiles(t.db, "org_s", { q: "photos" }))).toEqual(["beach.jpg"]); // kind word only → filtered list
    expect(names(await searchFiles(t.db, "org_s", { q: "duplicates" }))).toEqual(["beach.jpg"]);
    const r = await searchFiles(t.db, "org_s", { q: "", filters: { kind: "document" }, facets: true });
    expect(r.total).toBe(4);
    expect(r.facets!.space.map((s) => [s.name, s.count])).toEqual([
      ["Office", 3],
      ["Archive", 1],
    ]);
  });

  it("finds by meaning, merges with words (both rank first) and only compares the same model", async () => {
    const e = embedder();
    const bill = await searchFiles(t.db, "org_s", { q: "bill", embedder: e });
    expect(bill.semantic).toBe("on");
    expect(names(bill)).toEqual(expect.arrayContaining(["Invoice 1001.pdf", "invoice-2019.pdf"]));
    expect(bill.hits.every((h) => h.sources.join() === "meaning")).toBe(true);

    const inv = await searchFiles(t.db, "org_s", { q: "invoice", embedder: e, facets: true });
    expect(inv.hits[0]!.file.name).toBe("Invoice 1001.pdf");
    expect(inv.hits[0]!.sources).toEqual(["words", "meaning"]);
    expect(inv.facets!.category.find((c) => c.key === "Invoices")!.count).toBe(2);

    expect(names(await searchFiles(t.db, "org_s", { q: "holiday", embedder: e }))).toEqual(["beach.jpg"]);
    expect(names(await searchFiles(t.db, "org_s", { q: "bill", embedder: embedder("other:model") }))).toEqual([]);

    // The query vector is cached.
    const before = e.calls;
    await searchFiles(t.db, "org_s", { q: "bill", embedder: e });
    expect(e.calls).toBe(before);
  });

  it("falls back to words when the embedding model fails", async () => {
    const broken: Embedder = { model: "fake:words", embed: () => Promise.reject(new Error("Ollama is down")) };
    const r = await searchFiles(t.db, "org_s", { q: "invoice 1001 alpha", embedder: broken });
    expect(r.semantic).toBe("error");
    expect(r.semanticError).toMatch(/Ollama is down/);
    expect(names(r)).toEqual(["Invoice 1001.pdf"]);
  });

  it("uses the GIN index for words and the HNSW index for meaning", async () => {
    const vec = `[${fakeVector("invoice").join(",")}]`;
    const [words, meaning] = await t.db.transaction(async (tx) => {
      // Tiny tables are cheaper to scan; force index use to prove the indexes apply.
      await tx.execute(sql`set local enable_seqscan = off`);
      return [
        await tx.execute<{ "QUERY PLAN": string }>(sql`explain select id from files where search_tsv @@ to_tsquery('simple', 'invoice:*')`),
        await tx.execute<{ "QUERY PLAN": string }>(sql`explain select id from files order by embedding <=> ${vec}::vector limit 10`),
      ];
    });
    expect(words.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/files_search_tsv_gin/);
    expect(meaning.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/files_embedding_hnsw/);
  });
});
