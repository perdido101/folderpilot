/** Embeddings for search by meaning: padded vectors, unchanged text skipped, model change re-embeds, fallbacks. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_AI_SETTINGS } from "@folderpilot/ai";
import { DEFAULT_THRESHOLDS } from "@folderpilot/core";
import { createTestDatabase, files, organizations, saveOrgSettings, spaces, type TestDatabase } from "@folderpilot/db";
import { embedSpace } from "./pipeline/embeddings";

const key = Buffer.alloc(32, 5);
let t: TestDatabase;
let mock: http.Server;
let base = "";
let spaceId: string;
const seen: { path: string; body: { input: string[]; model: string } }[] = [];

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw) as { input: string[]; model: string };
      seen.push({ path: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/embed") res.end(JSON.stringify({ embeddings: body.input.map(() => [0.3, 0.4]) }));
      else res.end(JSON.stringify({ data: body.input.map((_t, index) => ({ index, embedding: [index + 1, 1, 0.5] })) }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  t = await createTestDatabase("fp_embed");
  await t.db.insert(organizations).values({ id: "org_e", name: "Embed", slug: "embed" });
  const [space] = await t.db.insert(spaces).values({ organizationId: "org_e", name: "S", mode: "private", adapterId: "local-server", rootRef: "/x" }).returning();
  spaceId = space!.id;
  await t.db.insert(files).values([
    { organizationId: "org_e", spaceId, providerRef: "a", path: "a.pdf", name: "a.pdf", ext: "pdf", analyzedAt: new Date(), caption: "Invoice" },
    { organizationId: "org_e", spaceId, providerRef: "b", path: "b.jpg", name: "b.jpg", ext: "jpg", analyzedAt: new Date() },
    { organizationId: "org_e", spaceId, providerRef: "c", path: "c.txt", name: "c.txt", ext: "txt" }, // not analyzed yet
  ]);
}, 60_000);

afterAll(async () => {
  await t?.drop();
  await new Promise<void>((r) => mock.close(() => r()));
});

const settings = (ai: Partial<typeof DEFAULT_AI_SETTINGS>) => saveOrgSettings(t.db, "org_e", key, { ai: { ...DEFAULT_AI_SETTINGS, ...ai }, thresholds: DEFAULT_THRESHOLDS, aiMonthlyFileBudget: 100 });
const deps = (fallback?: { ollamaUrl?: string; model?: string }) => ({ db: t.db, encryptionKey: key, ...(fallback ? { embedFallback: fallback } : {}) });
const job = () => ({ orgId: "org_e", spaceId });

describe("embeddings job", () => {
  it("does nothing without an embedding model", async () => {
    await settings({ provider: "anthropic" });
    expect(await embedSpace(deps(), job())).toEqual({ skipped: "no embedding model" });
  });

  it("embeds analyzed files once (padded to 1024), re-embeds changed text or a new model", async () => {
    await settings({ provider: "openai", openai: { ...DEFAULT_AI_SETTINGS.openai, baseUrl: base, apiKey: "k" } });
    expect(await embedSpace(deps(), job())).toMatchObject({ embedded: 2, model: "openai:text-embedding-3-small" });
    const [a] = await t.db.select().from(files).where(eq(files.name, "a.pdf"));
    expect(a!.embedding).toHaveLength(1024);
    expect(a!.embedding!.slice(0, 4)).toEqual([1, 1, 0.5, 0]);
    expect(seen.at(-1)!.body.input.join()).toContain("Invoice");

    expect(await embedSpace(deps(), job())).toMatchObject({ embedded: 0 });
    await t.db.update(files).set({ caption: "Paid invoice" }).where(eq(files.id, a!.id));
    expect(await embedSpace(deps(), job())).toMatchObject({ embedded: 1 });

    await settings({ provider: "openai", openai: { ...DEFAULT_AI_SETTINGS.openai, baseUrl: base, apiKey: "k", embedModel: "text-embedding-3-large" } });
    expect(await embedSpace(deps(), job())).toMatchObject({ embedded: 2, model: "openai:text-embedding-3-large" });
  });

  it("uses the server's Ollama when the org's AI can't embed", async () => {
    await settings({ provider: "folderpilot" });
    expect(await embedSpace(deps({ ollamaUrl: base, model: "mxbai-embed-large" }), job())).toMatchObject({ embedded: 2, model: "ollama:mxbai-embed-large" });
    expect(seen.at(-1)!.path).toBe("/api/embed");
  });
});
