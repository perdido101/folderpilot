/** Rules (CRUD as audited plans, auto needs admin, dry-run, run, convert) and pending plans (approve / edit / cancel). */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { LocalServerAdapter } from "@folderpilot/adapters";
import type { AIProvider } from "@folderpilot/ai";
import { auditEvents, createTestDatabase, files, memberships, plans, rules, spaces, users, type TestDatabase } from "@folderpilot/db";
import { createApp } from "./app";
import { createDeps } from "./deps";
import { TestClient } from "./testing/client";

let t: TestDatabase;
let runtime: ReturnType<typeof createDeps>;
let app: ReturnType<typeof createApp>;
let dir: string;
let orgId: string;
let spaceId: string;
let owner: TestClient;
let editor: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let aiReply = "";

const fakeAI: AIProvider = {
  label: "Fake AI",
  cacheKey: "fake:1",
  describeImage: () => Promise.reject(new Error("unused")),
  describeText: () => Promise.reject(new Error("unused")),
  async *chat() {
    yield { type: "done", content: aiReply, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "fake" };
  },
  test: async () => "ok",
};

interface PublicRule {
  id: string;
  name: string;
  mode: string;
  enabled: boolean;
  archived: boolean;
  scopeSpaceId: string | null;
}
interface PendingPlan {
  id: string;
  actor: string;
  summary: string;
  fileCount: number;
  steps: { seq: number; action: string; name: string; after: string }[];
}

const userId = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0]!.id;

async function addFile(name: string, extra: Partial<typeof files.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(files)
    .values({ organizationId: orgId, spaceId, providerRef: name, path: name, name, ext: name.split(".").pop()!, size: 5, version: "v1", analyzedAt: new Date(), ...extra })
    .returning();
  return row!;
}

const structured = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "structured",
  name,
  conditions: [{ field: "ext", op: "is", value: "txt" }],
  actions: [{ type: "tag", value: "text" }],
  ...extra,
});

beforeAll(async () => {
  t = await createTestDatabase("fp_rules");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-rules-"));
  runtime = createDeps(
    { NODE_ENV: "test", LOG_LEVEL: process.env.TEST_LOG ?? "silent", DATABASE_URL: t.url, REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379", FP_QUEUE_PREFIX: `fptest${Date.now()}` },
    {},
    { ai: { hosted: () => null, forOrg: (s) => (s.provider === "none" ? null : fakeAI) }, adapterFor: () => new LocalServerAdapter(dir) },
  );
  await runtime.start();
  app = createApp(runtime.deps);
  owner = new TestClient(app, "10.2.0.1");
  editor = new TestClient(app, "10.2.0.2");
  viewer = new TestClient(app, "10.2.0.3");
  stranger = new TestClient(app, "10.2.0.4");
  await owner.signUp("ro@example.com", "Owner");
  orgId = (await owner.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Rules Co", slug: "rules-co" } })).body.id;
  await editor.signUp("re@example.com", "Editor");
  await viewer.signUp("rv@example.com", "Viewer");
  await stranger.signUp("rs@example.com", "Stranger");
  await stranger.json("/api/auth/organization/create", { body: { name: "Other", slug: "rules-other" } });
  await t.db.insert(memberships).values([
    { id: randomUUID(), organizationId: orgId, userId: await userId("re@example.com"), role: "editor" },
    { id: randomUUID(), organizationId: orgId, userId: await userId("rv@example.com"), role: "viewer" },
  ]);
  const [space] = await t.db.insert(spaces).values({ organizationId: orgId, name: "Sample", mode: "private", adapterId: "local-server", rootRef: dir }).returning();
  spaceId = space!.id;
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await t?.drop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("rule CRUD", () => {
  it("creates, edits and archives rules as audited plans, and undo restores", async () => {
    const created = await editor.json<{ rule: PublicRule; batchId: string }>(`/api/orgs/${orgId}/rules`, { body: structured("Text files") });
    expect(created.status).toBe(201);
    expect(created.body.rule).toMatchObject({ name: "Text files", mode: "suggest", enabled: true, archived: false });
    const id = created.body.rule.id;

    const edited = await editor.json<{ rule: PublicRule; batchId: string }>(`/api/orgs/${orgId}/rules/${id}`, { method: "PUT", body: { name: "Plain text", scopeSpaceId: spaceId } });
    expect(edited.body.rule).toMatchObject({ name: "Plain text", scopeSpaceId: spaceId });

    const archived = await editor.json<{ rule: PublicRule; batchId: string }>(`/api/orgs/${orgId}/rules/${id}`, { method: "DELETE" });
    expect(archived.body.rule).toMatchObject({ archived: true, enabled: false });
    expect((await editor.json<{ rules: PublicRule[] }>(`/api/orgs/${orgId}/rules`)).body.rules.map((r) => r.id)).not.toContain(id);
    expect((await editor.json<{ rules: PublicRule[] }>(`/api/orgs/${orgId}/rules?archived=1`)).body.rules.map((r) => r.id)).toContain(id);

    const history = await editor.json<{ events: { action: string; actor: string }[] }>(`/api/orgs/${orgId}/rules/history`);
    expect(history.body.events.slice(0, 3).map((e) => e.action)).toEqual(["rule_update", "rule_update", "rule_create"]);
    expect(history.body.events[0]!.actor).toMatch(/^user:/);

    const undo = await editor.json<{ done: number }>(`/api/orgs/${orgId}/rules/undo`, { body: { batchId: archived.body.batchId } });
    expect(undo.body.done).toBe(1);
    const [row] = await t.db.select().from(rules).where(eq(rules.id, id));
    expect(row).toMatchObject({ archivedAt: null, enabled: true, name: "Plain text" });
  });

  it("validates rules (ops per field, unsafe regex, empty actions)", async () => {
    const bad = async (body: unknown) => (await editor.json<{ message: string }>(`/api/orgs/${orgId}/rules`, { body })).body.message;
    expect(await bad(structured("x", { conditions: [{ field: "size", op: "contains", value: "1" }] }))).toMatch(/doesn't work with size/);
    expect(await bad(structured("x", { conditions: [{ field: "name", op: "matches", value: "(a+)+$" }] }))).toMatch(/Nested/i);
    expect(await bad(structured("x", { actions: [] }))).toMatch(/at least one action/);
    expect(await bad(structured("x", { actions: [{ type: "delete", value: "" }] }))).toMatch(/actions/);
    expect(await bad({ type: "natural", name: "N" })).toMatch(/sentence/);
  });

  it("only admins make or change auto rules; editors may still pause them; viewers and strangers are refused", async () => {
    expect((await editor.req(`/api/orgs/${orgId}/rules`, { body: structured("Auto", { mode: "auto" }) })).status).toBe(403);
    const auto = await owner.json<{ rule: PublicRule }>(`/api/orgs/${orgId}/rules`, { body: structured("Auto", { mode: "auto", priority: 5 }) });
    expect(auto.body.rule.mode).toBe("auto");
    expect((await editor.req(`/api/orgs/${orgId}/rules/${auto.body.rule.id}`, { method: "PUT", body: { name: "Changed" } })).status).toBe(403);
    expect((await editor.req(`/api/orgs/${orgId}/rules/${auto.body.rule.id}`, { method: "PUT", body: { enabled: false } })).status).toBe(200);
    expect((await owner.req(`/api/orgs/${orgId}/rules/${auto.body.rule.id}`, { method: "PUT", body: { enabled: true } })).status).toBe(200);
    expect((await viewer.req(`/api/orgs/${orgId}/rules`, { body: structured("V") })).status).toBe(403);
    expect((await viewer.req(`/api/orgs/${orgId}/rules`)).status).toBe(200);
    expect((await stranger.req(`/api/orgs/${orgId}/rules`)).status).toBe(404);
    expect((await stranger.req(`/api/orgs/${orgId}/rules/${auto.body.rule.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("dry-run, run and approvals", () => {
  it("dry-runs an unsaved rule without changing anything", async () => {
    await addFile("notes.txt");
    await addFile("Screenshot 2026-01-01.png", { flags: ["screenshot"] });
    await addFile("photo.jpg");
    const res = await viewer.json<{ matches: number; steps: { name: string; action: string; after: string }[] }>(`/api/orgs/${orgId}/rules/test`, {
      body: { rule: structured("Shots", { conditions: [{ field: "flag", op: "has", value: "screenshot" }], actions: [{ type: "set_category", value: "Screenshots" }] }), spaceId },
    });
    expect(res.body.matches).toBe(1);
    expect(res.body.steps).toEqual([expect.objectContaining({ name: "Screenshot 2026-01-01.png", action: "category", after: "Screenshots" })]);
    expect((await t.db.select().from(files).where(eq(files.name, "Screenshot 2026-01-01.png")))[0]!.category).toBeNull();
  });

  it("runs rules: auto executes (audited as the rule), suggest waits for approval, no duplicate plans", async () => {
    const shots = await editor.json<{ rule: PublicRule }>(`/api/orgs/${orgId}/rules`, {
      body: structured("Shots", { conditions: [{ field: "flag", op: "has", value: "screenshot" }], actions: [{ type: "set_category", value: "Screenshots" }] }),
    });
    const run = await editor.json<{ outcomes: { ruleName: string; mode: string; result?: { done: number } }[] }>(`/api/orgs/${orgId}/rules/run`, { body: { spaceId } });
    expect(run.status).toBe(200);
    const auto = run.body.outcomes.find((o) => o.mode === "auto")!;
    expect(auto.result?.done).toBe(1);
    const txt = (await t.db.select().from(files).where(eq(files.name, "notes.txt")))[0]!;
    expect(txt.tags).toContain("text");
    const [ev] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.action, "tag")));
    expect(ev!.actor).toMatch(/^rule:/);

    const again = await editor.json<{ outcomes: unknown[] }>(`/api/orgs/${orgId}/rules/run`, { body: { spaceId } });
    expect(again.body.outcomes).toEqual([]);

    const pending = await viewer.json<{ plans: PendingPlan[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/plans?status=pending`);
    expect(pending.body.plans).toHaveLength(1);
    expect(pending.body.plans[0]).toMatchObject({ actor: `rule:${shots.body.rule.id}`, fileCount: 1 });
    expect(pending.body.plans[0]!.steps[0]).toMatchObject({ name: "Screenshot 2026-01-01.png", after: "Screenshots" });

    expect((await viewer.req(`/api/orgs/${orgId}/plans/${pending.body.plans[0]!.id}/approve`, { method: "POST" })).status).toBe(403);
    const approved = await editor.json<{ done: number; status: string }>(`/api/orgs/${orgId}/plans/${pending.body.plans[0]!.id}/approve`, { method: "POST" });
    expect(approved.body).toMatchObject({ done: 1, status: "executed" });
    expect((await t.db.select().from(files).where(eq(files.name, "Screenshot 2026-01-01.png")))[0]!.category).toBe("Screenshots");
    const [p] = await t.db.select().from(plans).where(eq(plans.id, pending.body.plans[0]!.id));
    expect(p!.approvedBy).toBe(await userId("re@example.com"));
  });

  it("edits (keeps some steps) and cancels pending plans; another org can't see them", async () => {
    await addFile("a.md");
    await addFile("b.md");
    await editor.json(`/api/orgs/${orgId}/rules`, { body: structured("Markdown", { conditions: [{ field: "ext", op: "is", value: "md" }], actions: [{ type: "tag", value: "md" }] }) });
    await editor.json(`/api/orgs/${orgId}/rules/run`, { body: { spaceId } });
    const [plan] = (await editor.json<{ plans: PendingPlan[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/plans`)).body.plans.filter((p) => p.summary.startsWith("Markdown"));
    expect(plan!.steps).toHaveLength(2);
    expect((await stranger.req(`/api/orgs/${orgId}/plans/${plan!.id}/cancel`, { method: "POST" })).status).toBe(404);
    await editor.json(`/api/orgs/${orgId}/plans/${plan!.id}/keep-steps`, { body: { seqs: [plan!.steps[0]!.seq] } });
    const res = await editor.json<{ done: number }>(`/api/orgs/${orgId}/plans/${plan!.id}/approve`, { method: "POST" });
    expect(res.body.done).toBe(1);

    await editor.json(`/api/orgs/${orgId}/rules/run`, { body: { spaceId } });
    const [next] = (await editor.json<{ plans: PendingPlan[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/plans`)).body.plans.filter((p) => p.summary.startsWith("Markdown"));
    expect(next!.fileCount).toBe(1);
    expect((await editor.json<{ ok: boolean }>(`/api/orgs/${orgId}/plans/${next!.id}/cancel`, { method: "POST" })).body.ok).toBe(true);
    expect((await editor.req(`/api/orgs/${orgId}/plans/${next!.id}/approve`, { method: "POST" })).status).toBe(409);
  });

  it("runs on one folder only", async () => {
    await addFile("Inbox/c.log");
    await addFile("Other/d.log");
    await editor.json(`/api/orgs/${orgId}/rules`, { body: structured("Logs", { conditions: [{ field: "ext", op: "is", value: "log" }], actions: [{ type: "tag", value: "log" }] }) });
    const run = await editor.json<{ files: number }>(`/api/orgs/${orgId}/rules/run`, { body: { spaceId, folder: "Inbox" } });
    expect(run.body.files).toBe(1);
  });

  it("returns a 'Make this a rule?' hint after a manual recategorization", async () => {
    const f = await addFile("Finance/inv-1.pdf", { entities: { docType: "invoice" } });
    const res = await editor.json<{ ruleHint: unknown }>(`/api/orgs/${orgId}/spaces/${spaceId}/review`, { body: { action: "set_category", fileIds: [f.id], category: "Invoices" } });
    expect(res.body.ruleHint).toEqual({ category: "Invoices", ext: "pdf", folder: "Finance", docType: "invoice" });
  });
});

describe("convert natural → structured", () => {
  it("needs a configured AI, returns a validated proposal, and explains refusals", async () => {
    expect((await editor.req(`/api/orgs/${orgId}/rules/convert`, { body: { text: "screenshots to Temp" } })).status).toBe(409);
    await owner.json(`/api/orgs/${orgId}/settings/ai`, {
      method: "PUT",
      body: { ai: { provider: "ollama" }, thresholds: { nearDuplicateDistance: 6, blur: 100, dark: 40, tiny: 64, confidence: 0.6 }, aiMonthlyFileBudget: 100 },
    });
    aiReply = JSON.stringify({ name: "Screenshots", match: "all", conditions: [{ field: "flag", op: "has", value: "screenshot" }], actions: [{ type: "move", value: "Temp" }] });
    const ok = await editor.json<{ proposal: { name: string } }>(`/api/orgs/${orgId}/rules/convert`, { body: { text: "screenshots to Temp" } });
    expect(ok.status).toBe(200);
    expect(ok.body.proposal.name).toBe("Screenshots");
    aiReply = '{"error": "Rules can\'t send email."}';
    const no = await editor.json<{ message: string }>(`/api/orgs/${orgId}/rules/convert`, { body: { text: "email me invoices" } });
    expect(no.status).toBe(422);
    expect(no.body.message).toBe("Rules can't send email.");
    expect((await viewer.req(`/api/orgs/${orgId}/rules/convert`, { body: { text: "x y z" } })).status).toBe(403);
  });
});
