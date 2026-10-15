/** The agent for server spaces: streamed events, tools scoped to org/space/role, plans not changes, tool-call log. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { LocalServerAdapter } from "@folderpilot/adapters";
import type { AgentEvent, AIProvider, ChatEvent, ChatMessage, ToolCall } from "@folderpilot/ai";
import { DEFAULT_THRESHOLDS } from "@folderpilot/core";
import { agentToolCalls, aiUsage, auditEvents, createTestDatabase, files, memberships, plans, rules, spaces, users, type TestDatabase } from "@folderpilot/db";
import { createApp } from "./app";
import { createDeps } from "./deps";
import { TestClient } from "./testing/client";

let t: TestDatabase;
let runtime: ReturnType<typeof createDeps>;
let app: ReturnType<typeof createApp>;
let dir: string;
let orgId: string;
let spaceId: string;
let otherSpaceFileId: string;
let owner: TestClient;
let editor: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let aiOn = true;

/** Scripted turns; each turn is either tool calls (computed from what the model has seen) or a text reply. */
type Turn = (messages: ChatMessage[]) => { text?: string; calls?: ToolCall[] };
let script: Turn[] = [];
let seen: ChatMessage[][] = [];

const fakeAI: AIProvider = {
  label: "Fake AI",
  cacheKey: "fake:1",
  describeImage: () => Promise.reject(new Error("unused")),
  describeText: () => Promise.reject(new Error("unused")),
  async *chat(_system, messages) {
    seen.push([...messages]);
    const turn: { text?: string; calls?: ToolCall[] } = (script.shift() ?? (() => ({ text: "Done." })))(messages);
    if (turn.text) for (const w of turn.text.split(/(?<= )/)) yield { type: "text", text: w } satisfies ChatEvent;
    yield { type: "done", content: turn.text ?? "", toolCalls: turn.calls ?? [], usage: { inputTokens: 100, outputTokens: 10 }, model: "fake-model" } satisfies ChatEvent;
  },
  test: async () => "ok",
};

const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `c_${Math.random().toString(36).slice(2)}`, name, input });
/** The last tool result the model saw, parsed. */
const lastResult = (messages: ChatMessage[]) => JSON.parse((messages.at(-1) as { content: string }).content) as Record<string, unknown> & { files?: { id: string; name: string }[] };

async function ask(client: TestClient, message: string, history: ChatMessage[] = [], space = spaceId) {
  const res = await client.req(`/api/orgs/${orgId}/spaces/${space}/agent`, { body: { message, history } });
  if (res.status !== 200) return { status: res.status, events: [] as AgentEvent[], body: await res.text() };
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()) as AgentEvent);
  return { status: res.status, events, body: text };
}

const userId = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0]!.id;

async function addFile(filePath: string, extra: Partial<typeof files.$inferInsert> = {}, space = spaceId) {
  const name = filePath.split("/").pop()!;
  const [row] = await t.db
    .insert(files)
    .values({ organizationId: orgId, spaceId: space, providerRef: filePath, path: filePath, name, ext: name.split(".").pop()!, size: 1000, version: "v1", mtime: new Date("2026-03-01"), analyzedAt: new Date(), ...extra })
    .returning();
  return row!;
}

beforeAll(async () => {
  t = await createTestDatabase("fp_agent");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-agent-"));
  runtime = createDeps(
    { NODE_ENV: "test", LOG_LEVEL: process.env.TEST_LOG ?? "silent", DATABASE_URL: t.url, REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379", FP_QUEUE_PREFIX: `fptest${Date.now()}a` },
    {},
    { ai: { hosted: () => null, forOrg: () => (aiOn ? fakeAI : null) }, adapterFor: () => new LocalServerAdapter(dir) },
  );
  await runtime.start();
  app = createApp(runtime.deps);
  owner = new TestClient(app, "10.3.0.1");
  editor = new TestClient(app, "10.3.0.2");
  viewer = new TestClient(app, "10.3.0.3");
  stranger = new TestClient(app, "10.3.0.4");
  await owner.signUp("ao@example.com", "Owner");
  orgId = (await owner.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Agent Co", slug: "agent-co" } })).body.id;
  await editor.signUp("ae@example.com", "Editor");
  await viewer.signUp("av@example.com", "Viewer");
  await stranger.signUp("as@example.com", "Stranger");
  await stranger.json("/api/auth/organization/create", { body: { name: "Other", slug: "agent-other" } });
  await t.db.insert(memberships).values([
    { id: randomUUID(), organizationId: orgId, userId: await userId("ae@example.com"), role: "editor" },
    { id: randomUUID(), organizationId: orgId, userId: await userId("av@example.com"), role: "viewer" },
  ]);
  const [space] = await t.db.insert(spaces).values({ organizationId: orgId, name: "Office", mode: "private", adapterId: "local-server", rootRef: dir }).returning();
  spaceId = space!.id;
  const [other] = await t.db.insert(spaces).values({ organizationId: orgId, name: "Elsewhere", mode: "private", adapterId: "local-server", rootRef: dir }).returning();
  await addFile("Invoices/inv-1001.pdf", { category: "Invoices", entities: { client: "Alpha Ltd", docType: "invoice" }, textExcerpt: "INVOICE 1001 Alpha Ltd" });
  await addFile("Invoices/inv-1002.pdf", { category: "Invoices", entities: { client: "Beta GmbH", docType: "invoice" } });
  await addFile("Photos/beach.jpg", { category: "Photos", flags: ["duplicate"], mtime: new Date("2025-07-01") });
  await addFile("Photos/beach - Copy.jpg", { category: "Photos", flags: ["duplicate"], mtime: new Date("2025-07-01") });
  otherSpaceFileId = (await addFile("secret.pdf", {}, other!.id)).id;
}, 60_000);

beforeEach(() => {
  script = [];
  seen = [];
  aiOn = true;
});

afterAll(async () => {
  await runtime?.stop();
  await t?.drop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("agent chat", () => {
  it("streams text and tool progress, proposes a plan that waits for approval, and logs every tool call", async () => {
    script = [
      () => ({ calls: [call("search_files", { query: "invoice alpha" })] }),
      (m) => ({ calls: [call("propose_plan", { summary: "Tag Alpha's invoice as paid", steps: [{ fileId: lastResult(m).files![0]!.id, action: "tag", to: "Paid" }] })] }),
      () => ({ text: "I've prepared a plan; it is waiting for your approval." }),
    ];
    const { events } = await ask(editor, "tag the Alpha invoice as paid");
    const kinds = events.filter((e) => e.type !== "text").map((e) => (e.type === "tool" ? `tool:${e.name}:${e.status}` : e.type));
    expect(kinds).toEqual(["tool:search_files:running", "tool:search_files:done", "files", "tool:propose_plan:running", "tool:propose_plan:done", "plan", "done"]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("I've prepared a plan; it is waiting for your approval.");
    expect(events.findIndex((e) => e.type === "text")).toBeGreaterThan(events.findIndex((e) => e.type === "plan"));
    const plan = events.find((e) => e.type === "plan") as { planId: string };
    const [row] = await t.db.select().from(plans).where(eq(plans.id, plan.planId));
    expect(row).toMatchObject({ source: "agent", actor: `agent:${await userId("ae@example.com")}`, status: "pending", spaceId });
    expect((await t.db.select().from(files).where(eq(files.name, "inv-1001.pdf")))[0]!.tags).toEqual([]);

    // The plan card loads by id; approving goes through the normal route and is audited under the agent.
    const card = await editor.json<{ plan: { summary: string; steps: { name: string; after: string }[] } }>(`/api/orgs/${orgId}/plans/${plan.planId}`);
    expect(card.body.plan.steps[0]).toMatchObject({ name: "inv-1001.pdf", after: "paid" });
    expect((await viewer.req(`/api/orgs/${orgId}/plans/${plan.planId}/approve`, { method: "POST" })).status).toBe(403);
    expect((await owner.json<{ done: number }>(`/api/orgs/${orgId}/plans/${plan.planId}/approve`, { method: "POST" })).body.done).toBe(1);
    expect((await t.db.select().from(files).where(eq(files.name, "inv-1001.pdf")))[0]!.tags).toEqual(["paid"]);
    const [ev] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.planId, plan.planId)));
    expect(ev!.actor).toMatch(/^agent:/);

    const logged = await t.db.select().from(agentToolCalls).where(eq(agentToolCalls.organizationId, orgId));
    expect(logged.map((l) => [l.tool, l.ok])).toEqual(expect.arrayContaining([["search_files", true], ["propose_plan", true]]));
    expect(logged[0]!.input).toContain("invoice");
    const [usage] = await t.db.select().from(aiUsage).where(and(eq(aiUsage.organizationId, orgId), eq(aiUsage.purpose, "agent")));
    expect(usage).toMatchObject({ inputTokens: 300, outputTokens: 30, model: "fake-model" });
  });

  it("keeps tools inside the space and refuses delete", async () => {
    script = [() => ({ calls: [call("get_file", { id: otherSpaceFileId }), call("delete_files", { ids: [otherSpaceFileId] })] }), () => ({ text: "I can't." })];
    const { events } = await ask(editor, "delete secret.pdf");
    const errors = events.filter((e) => e.type === "tool" && e.status === "error");
    expect(errors).toHaveLength(2);
    const results = seen[1]!.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(results[0]).toMatch(/not in this space/);
    expect(results[1]).toMatch(/no delete tool/);
  });

  it("respects the person's role: viewers can't propose rules, but can read and propose plans", async () => {
    const f = (await t.db.select().from(files).where(eq(files.name, "beach.jpg")))[0]!;
    script = [
      () => ({ calls: [call("propose_rule", { name: "PDFs", conditions: [{ field: "ext", op: "is", value: "pdf" }], actions: [{ type: "tag", value: "pdf" }] }), call("propose_plan", { summary: "Tag", steps: [{ fileId: f.id, action: "tag", to: "summer" }] })] }),
      () => ({ text: "ok" }),
    ];
    const { events } = await ask(viewer, "make a rule");
    const results = seen[1]!.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(results[0]).toMatch(/can't manage rules/);
    expect(JSON.parse(results[1]!)).toMatchObject({ status: "pending_approval" });
    const planId = (events.find((e) => e.type === "plan") as { planId: string }).planId;
    await owner.req(`/api/orgs/${orgId}/plans/${planId}/cancel`, { method: "POST" });
    expect((await t.db.select().from(rules).where(eq(rules.organizationId, orgId))).length).toBe(0);
  });

  it("proposes and revises rules (always Suggest), answers stats, filters the audit log, and proposes undo", async () => {
    script = [
      () => ({ calls: [call("propose_rule", { name: "Invoices", conditions: [{ field: "docType", op: "is", value: "invoice" }], actions: [{ type: "move", value: "Finance/{client}" }] })] }),
      (m) => ({ calls: [call("update_rule_proposal", { planId: lastResult(m).planId, changes: { name: "Invoices by client" } })] }),
      () => ({ calls: [call("stats", { question: "files per category", groupBy: "category" }), call("stats", { question: "duplicates", groupBy: "flag" }), call("stats", { question: "by year", groupBy: "year", metric: "size" })] }),
      () => ({ calls: [call("get_audit", { actor: "agent" })] }),
      (m) => ({ calls: [call("propose_undo", { batchId: (lastResult(m) as unknown as { batchId: string }[])[0]!.batchId })] }),
      () => ({ text: "Done." }),
    ];
    const { events } = await ask(owner, "organize invoices and give me numbers");
    const planIds = events.filter((e) => e.type === "plan").map((e) => (e as { planId: string }).planId);
    expect(planIds).toHaveLength(3);
    const [first, revised, undo] = await Promise.all(planIds.map(async (id) => (await t.db.select().from(plans).where(eq(plans.id, id)))[0]!));
    expect(first!.status).toBe("cancelled");
    expect(revised).toMatchObject({ status: "pending", summary: "Create rule “Invoices by client”" });
    expect(undo).toMatchObject({ status: "pending", source: "agent" });

    const toolResults = seen.flatMap((s) => s.filter((m) => m.role === "tool")).map((m) => JSON.parse((m as { content: string }).content));
    const byCategory = toolResults.find((r) => r.groupBy === "category");
    expect(byCategory.groups).toEqual([
      { key: "Invoices", value: 2 },
      { key: "Photos", value: 2 },
    ]);
    expect(toolResults.find((r) => r.groupBy === "flag").groups).toEqual([{ key: "duplicate", value: 2 }]);
    expect(toolResults.find((r) => r.groupBy === "year").groups).toEqual([
      { key: "2025", value: 2000 },
      { key: "2026", value: 2000 },
    ]);
    const audit = toolResults.find((r) => Array.isArray(r) && r[0]?.actor);
    expect(audit[0].actor).toMatch(/^agent:/);
    // The rule is only created if a person approves; and it is never auto.
    const approved = await owner.json<{ done: number }>(`/api/orgs/${orgId}/plans/${revised!.id}/approve`, { method: "POST" });
    expect(approved.body.done).toBe(1);
    const [rule] = await t.db.select().from(rules).where(eq(rules.organizationId, orgId));
    expect(rule).toMatchObject({ name: "Invoices by client", mode: "suggest" });
  });

  it("flag_for_deletion is a plan; it runs by itself only under the admin's auto-run threshold", async () => {
    const photo = (await t.db.select().from(files).where(eq(files.name, "beach - Copy.jpg")))[0]!;
    script = [() => ({ calls: [call("flag_for_deletion", { fileIds: [photo.id], reason: "exact copy" })] }), () => ({ text: "Flagged for review." })];
    let { events } = await ask(editor, "flag the copy");
    let planId = (events.find((e) => e.type === "plan") as { planId: string }).planId;
    expect((await t.db.select().from(plans).where(eq(plans.id, planId)))[0]!.status).toBe("pending");
    await owner.req(`/api/orgs/${orgId}/plans/${planId}/cancel`, { method: "POST" });

    const settings = await owner.json<{ settings: { ai: unknown; thresholds: unknown; aiMonthlyFileBudget: number } }>(`/api/orgs/${orgId}/settings/ai`);
    await owner.json(`/api/orgs/${orgId}/settings/ai`, { method: "PUT", body: { ai: { provider: "ollama" }, thresholds: DEFAULT_THRESHOLDS, aiMonthlyFileBudget: settings.body.settings.aiMonthlyFileBudget, autoRun: { maxFiles: 5, allowMcp: false } } });
    script = [() => ({ calls: [call("flag_for_deletion", { fileIds: [photo.id], reason: "exact copy" })] }), () => ({ text: "Flagged." })];
    ({ events } = await ask(editor, "flag the copy"));
    planId = (events.find((e) => e.type === "plan") as { planId: string }).planId;
    expect((await t.db.select().from(plans).where(eq(plans.id, planId)))[0]!.status).toBe("executed");
    expect((await t.db.select().from(files).where(eq(files.id, photo.id)))[0]!.flags).toContain("suggested_delete");
    expect((await t.db.select().from(files).where(eq(files.id, photo.id)))[0]!.status).not.toBe("trashed");
  });

  it("activity log: admins see everyone, others see their own; other orgs and missing AI are refused", async () => {
    const mine = await viewer.json<{ calls: { userId: string }[] }>(`/api/orgs/${orgId}/agent/activity`);
    expect(new Set(mine.body.calls.map((c) => c.userId))).toEqual(new Set([await userId("av@example.com")]));
    const all = await owner.json<{ calls: { userId: string }[] }>(`/api/orgs/${orgId}/agent/activity`);
    expect(new Set(all.body.calls.map((c) => c.userId)).size).toBeGreaterThan(1);

    expect((await stranger.req(`/api/orgs/${orgId}/spaces/${spaceId}/agent`, { body: { message: "hi" } })).status).toBe(404);
    expect((await stranger.req(`/api/orgs/${orgId}/agent/activity`)).status).toBe(404);
    aiOn = false;
    const res = await ask(editor, "hello");
    expect(res.status).toBe(409);
    expect(res.body).toMatch(/No AI is connected/);
  });
});
