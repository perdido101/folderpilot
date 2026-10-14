/** AI settings, FolderPilot AI proxy, and the files/duplicates/review/audit routes of a server space. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { LocalServerAdapter } from "@folderpilot/adapters";
import { DEFAULT_AI_SETTINGS, type AIProvider, type FileInsight } from "@folderpilot/ai";
import { DEFAULT_THRESHOLDS } from "@folderpilot/core";
import { aiUsage, createTestDatabase, files, memberships, orgSettings, spaces, users, type TestDatabase } from "@folderpilot/db";
import { createApp } from "./app";
import { createDeps } from "./deps";
import { TestClient } from "./testing/client";

let t: TestDatabase;
let runtime: ReturnType<typeof createDeps>;
let app: ReturnType<typeof createApp>;
let dir: string;
let orgId: string;
let otherOrgId: string;
let spaceId: string;
let owner: TestClient;
let editor: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let hostedCalls = 0;

const insight: FileInsight = { category: "Invoices", tags: ["invoice"], caption: "An invoice.", suggestedName: "Invoice", entities: { client: "Alpha", date: null, amount: null, docType: "invoice" }, confidence: 0.9, reason: "r" };
const fakeHosted: AIProvider = {
  label: "FolderPilot AI",
  cacheKey: "folderpilot:fake",
  async describeImage() {
    hostedCalls++;
    return { insight, usage: { inputTokens: 300, outputTokens: 40 }, model: "fake" };
  },
  async describeText() {
    hostedCalls++;
    return { insight, usage: { inputTokens: 100, outputTokens: 20 }, model: "fake" };
  },
  async *chat() {
    yield { type: "text", text: "Hel" };
    yield { type: "text", text: "lo" };
    yield { type: "done", content: "Hello", toolCalls: [], usage: { inputTokens: 7, outputTokens: 2 }, model: "fake" };
  },
  async test() {
    return "ok";
  },
};
const meta = (sha?: string) => ({ name: "a.pdf", path: "a.pdf", ext: "pdf", size: 10, mtime: 0, flags: [], ...(sha ? { sha256: sha } : {}) });
const ctx = { knownCategories: [], naturalRules: [] };

async function userId(email: string) {
  return (await t.db.select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function addFile(name: string, extra: Partial<typeof files.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(files)
    .values({ organizationId: orgId, spaceId, providerRef: name, path: name, name, ext: name.split(".").pop()!, size: 5, version: `5-${Date.now()}`, analyzedAt: new Date(), ...extra })
    .returning();
  return row!;
}

beforeAll(async () => {
  t = await createTestDatabase("fp_ai_files");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-space-"));
  runtime = createDeps(
    { NODE_ENV: "test", LOG_LEVEL: process.env.TEST_LOG ?? "silent", DATABASE_URL: t.url, REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379", ANTHROPIC_API_KEY: "sk-ant-fake", FP_QUEUE_PREFIX: `fptest${Date.now()}` },
    {},
    { ai: { hosted: () => fakeHosted, forOrg: () => fakeHosted }, adapterFor: () => new LocalServerAdapter(dir) },
  );
  await runtime.start();
  app = createApp(runtime.deps);
  owner = new TestClient(app, "10.1.0.1");
  editor = new TestClient(app, "10.1.0.2");
  viewer = new TestClient(app, "10.1.0.3");
  stranger = new TestClient(app, "10.1.0.4");
  await owner.signUp("o@example.com", "Owner");
  orgId = (await owner.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Alpha", slug: "alpha-ai" } })).body.id;
  await editor.signUp("e@example.com", "Editor");
  await viewer.signUp("v@example.com", "Viewer");
  await stranger.signUp("s@example.com", "Stranger");
  otherOrgId = (await stranger.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Other", slug: "other-ai" } })).body.id;
  await t.db.insert(memberships).values([
    { id: randomUUID(), organizationId: orgId, userId: await userId("e@example.com"), role: "editor" },
    { id: randomUUID(), organizationId: orgId, userId: await userId("v@example.com"), role: "viewer" },
  ]);
  const [space] = await t.db.insert(spaces).values({ organizationId: orgId, name: "Sample", mode: "private", adapterId: "local-server", rootRef: dir }).returning();
  spaceId = space!.id;
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await t?.drop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("AI settings", () => {
  it("admins save a key that is encrypted and never returned; others can't change it", async () => {
    const body = { ai: { ...DEFAULT_AI_SETTINGS, provider: "openai", openai: { ...DEFAULT_AI_SETTINGS.openai, apiKey: "sk-secret-123" } }, thresholds: DEFAULT_THRESHOLDS, aiMonthlyFileBudget: 3 };
    expect((await editor.req(`/api/orgs/${orgId}/settings/ai`, { method: "PUT", body })).status).toBe(403);
    const saved = await owner.json<{ settings: { ai: { openai: { apiKey: string } }; secretsSet: Record<string, boolean> } }>(`/api/orgs/${orgId}/settings/ai`, { method: "PUT", body });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.ai.openai.apiKey).toBe("");
    expect(saved.body.settings.secretsSet["openai.apiKey"]).toBe(true);
    const got = await owner.req(`/api/orgs/${orgId}/settings/ai`);
    expect(await got.text()).not.toContain("sk-secret-123");
    const [row] = await t.db.select().from(orgSettings).where(eq(orgSettings.organizationId, orgId));
    expect(JSON.stringify(row)).not.toContain("sk-secret-123");
    expect((await viewer.req(`/api/orgs/${orgId}/settings/ai`)).status).toBe(403);
    expect((await stranger.req(`/api/orgs/${orgId}/settings/ai`)).status).toBe(404);
  });

  it("rejects invalid settings", async () => {
    const res = await owner.json<{ message: string }>(`/api/orgs/${orgId}/settings/ai`, { method: "PUT", body: { ai: { provider: "skynet" }, thresholds: DEFAULT_THRESHOLDS, aiMonthlyFileBudget: -1 } });
    expect(res.status).toBe(400);
  });

  it("tests the configured provider and reports status to every member", async () => {
    expect((await owner.json<{ ok: boolean }>(`/api/orgs/${orgId}/settings/ai/test`, { method: "POST", body: {} })).body.ok).toBe(true);
    expect((await viewer.json<{ label: string }>(`/api/orgs/${orgId}/ai/status`)).body.label).toBe("FolderPilot AI");
  });
});

describe("FolderPilot AI for folders on this device", () => {
  it("describes thumbnails/text for members who can organize, caches by hash and meters usage", async () => {
    expect((await viewer.req(`/api/orgs/${orgId}/ai/describe`, { body: { kind: "text", text: "x", meta: meta(), ctx } })).status).toBe(403);
    expect((await stranger.req(`/api/orgs/${orgId}/ai/describe`, { body: { kind: "text", text: "x", meta: meta(), ctx } })).status).toBe(404);

    const first = await editor.json<{ insight: FileInsight; cached: boolean }>(`/api/orgs/${orgId}/ai/describe`, { body: { kind: "image", image: Buffer.from("jpeg").toString("base64"), mediaType: "image/jpeg", meta: meta("h1"), ctx } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ insight: { category: "Invoices" }, cached: false });
    const again = await editor.json<{ cached: boolean }>(`/api/orgs/${orgId}/ai/describe`, { body: { kind: "text", text: "x", meta: meta("h1"), ctx } });
    expect(again.body.cached).toBe(true);
    expect(hostedCalls).toBe(1);
    const usage = await t.db.select().from(aiUsage).where(eq(aiUsage.organizationId, orgId));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ files: 1, inputTokens: 300, outputTokens: 40, purpose: "analysis" });
  });

  it("rejects oversized thumbnails and stops at the monthly budget", async () => {
    const big = await editor.json<{ message: string }>(`/api/orgs/${orgId}/ai/describe`, { body: { kind: "image", image: "A".repeat(800_000), mediaType: "image/jpeg", meta: meta(), ctx } });
    expect(big.status).toBe(400);
    expect(big.body.message).toMatch(/512px/);
    // Budget is 3 files: one used, two more allowed.
    for (const sha of ["h2", "h3"]) expect((await editor.req(`/api/orgs/${orgId}/ai/describe`, { body: { kind: "text", text: "x", meta: meta(sha), ctx } })).status).toBe(200);
    const over = await editor.json<{ message: string }>(`/api/orgs/${orgId}/ai/describe`, { body: { kind: "text", text: "x", meta: meta("h4"), ctx } });
    expect(over.status).toBe(429);
    expect(over.body.message).toMatch(/Monthly AI budget/);
  });

  it("streams chat over server-sent events and records agent usage", async () => {
    const res = await viewer.req(`/api/orgs/${orgId}/ai/chat`, { body: { system: "s", messages: [{ role: "user", content: "hi" }], tools: [] } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"type":"text","text":"Hel"');
    expect(text).toContain('"type":"done"');
    const usage = await t.db.select().from(aiUsage).where(eq(aiUsage.purpose, "agent"));
    expect(usage[0]).toMatchObject({ inputTokens: 7, outputTokens: 2, files: 0 });
  });
});

describe("space files", () => {
  it("lists with filters, counts status, and groups duplicates", async () => {
    await addFile("inv.pdf", { status: "analyzed", category: "Invoices", sha256: "same" });
    await addFile("inv (1).pdf", { status: "analyzed", category: "Invoices", sha256: "same", flags: ["duplicate"] });
    const unsure = await addFile("scan.jpg", { status: "needs_review", category: "Scans", confidence: 0.4 });
    const list = await viewer.json<{ files: { name: string }[]; total: number }>(`/api/orgs/${orgId}/spaces/${spaceId}/files?status=needs_review`);
    expect(list.body.files.map((f) => f.name)).toEqual(["scan.jpg"]);
    expect((await viewer.json<{ total: number }>(`/api/orgs/${orgId}/spaces/${spaceId}/files?flag=duplicate`)).body.total).toBe(1);
    const status = await viewer.json<{ total: number; needsReview: number; adapter: { readOnly: boolean } }>(`/api/orgs/${orgId}/spaces/${spaceId}/status`);
    expect(status.body).toMatchObject({ total: 3, needsReview: 1, adapter: { readOnly: true } });
    const dups = await viewer.json<{ groups: { kind: string; keep: { name: string }; others: { name: string }[] }[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/duplicates`);
    expect(dups.body.groups).toEqual([expect.objectContaining({ kind: "exact", keep: expect.objectContaining({ name: "inv.pdf" }), others: [expect.objectContaining({ name: "inv (1).pdf" })] })]);
    expect(unsure.id).toBeDefined();
  });

  it("is invisible to other organizations", async () => {
    expect((await stranger.req(`/api/orgs/${otherOrgId}/spaces/${spaceId}/files`)).status).toBe(404);
    expect((await stranger.req(`/api/orgs/${orgId}/spaces/${spaceId}/files`)).status).toBe(404);
  });

  it("accepting a suggestion goes through the engine: audited and undoable", async () => {
    const [scan] = await t.db.select().from(files).where(eq(files.name, "scan.jpg"));
    expect((await viewer.req(`/api/orgs/${orgId}/spaces/${spaceId}/review`, { body: { action: "accept", fileIds: [scan!.id] } })).status).toBe(403);
    const res = await editor.json<{ done: number; batchId: string }>(`/api/orgs/${orgId}/spaces/${spaceId}/review`, { body: { action: "accept", fileIds: [scan!.id] } });
    expect(res.body.done).toBe(1);
    expect((await t.db.select().from(files).where(eq(files.id, scan!.id)))[0]!.status).toBe("analyzed");

    const audit = await viewer.json<{ events: { action: string; actor: string; undoneBy: string | null }[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/audit`);
    expect(audit.body.events[0]).toMatchObject({ action: "category", actor: `user:${await userId("e@example.com")}`, undoneBy: null });

    const undo = await editor.json<{ done: number }>(`/api/orgs/${orgId}/spaces/${spaceId}/undo`, { body: { batchId: res.body.batchId } });
    expect(undo.body.done).toBe(1);
    expect((await t.db.select().from(files).where(eq(files.id, scan!.id)))[0]!.status).toBe("needs_review");
    const after = await viewer.json<{ events: { action: string; undoneBy: string | null }[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/audit`);
    expect(after.body.events.find((e) => e.action === "category")!.undoneBy).toMatch(/^user:/);
  });

  it("trash is refused on a read-only space with a clear message, and files of another space can't be targeted", async () => {
    const [inv] = await t.db.select().from(files).where(eq(files.name, "inv (1).pdf"));
    const res = await owner.json<{ done: number; failed: number; errors: string[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/review`, { body: { action: "trash", fileIds: [inv!.id] } });
    expect(res.body).toMatchObject({ done: 0, failed: 1 });
    expect(res.body.errors[0]).toMatch(/read-only/);
    expect((await owner.req(`/api/orgs/${orgId}/spaces/${spaceId}/review`, { body: { action: "keep", fileIds: [randomUUID()] } })).status).toBe(404);
  });

  it("queues a scan", async () => {
    expect((await editor.req(`/api/orgs/${orgId}/spaces/${spaceId}/scan`, { body: { withAI: false } })).status).toBe(202);
  });
});
