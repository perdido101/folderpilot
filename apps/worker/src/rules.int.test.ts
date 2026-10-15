/**
 * Rule triggers on a real folder, Postgres and Redis: after a scan, auto rules execute (audited as the rule) and suggest
 * rules create exactly one pending plan; re-scans don't duplicate plans; a due scheduled rule runs once per interval.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adapterForSpace } from "@folderpilot/adapters";
import { auditEvents, createTestDatabase, files, organizations, plans, planSteps, rules, spaces, type TestDatabase } from "@folderpilot/db";
import type { IndexJob, RulesJob } from "@folderpilot/core";
import { rulesTick } from "./pipeline/rules";
import { startWorker, type WorkerRuntime } from "./worker";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const key = Buffer.alloc(32, 4);
const ORG = "org_rules";
let t: TestDatabase;
let dir: string;
let runtime: WorkerRuntime;
let spaceId: string;
let autoId: string;
let suggestId: string;

const pipeline = () => ({
  db: t.db,
  encryptionKey: key,
  hosted: { analysisModel: "x", agentModel: "y" },
  adapterFor: (s: typeof spaces.$inferSelect) => adapterForSpace(s, { devSampleDir: dir, production: false }),
});

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const fileNamed = async (name: string) => (await t.db.select().from(files).where(and(eq(files.organizationId, ORG), eq(files.name, name))))[0];
const pendingPlans = () => t.db.select().from(plans).where(and(eq(plans.organizationId, ORG), eq(plans.status, "pending")));
const scan = (): Promise<unknown> => runtime.queues.indexing.add("index", { orgId: ORG, spaceId, withAI: false } satisfies IndexJob, { jobId: `index_${Date.now()}` });

beforeAll(async () => {
  t = await createTestDatabase("fp_rules_worker");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-rules-worker-"));
  await fs.writeFile(path.join(dir, "notes.txt"), "plain text");
  await fs.writeFile(path.join(dir, "todo.txt"), "more text");
  await fs.writeFile(path.join(dir, "readme.md"), "# Read me");

  await t.db.insert(organizations).values({ id: ORG, name: "Rules", slug: "rules-worker" });
  const [space] = await t.db.insert(spaces).values({ organizationId: ORG, name: "Sample", mode: "private", adapterId: "local-server", rootRef: dir }).returning();
  spaceId = space!.id;
  const base = { organizationId: ORG, type: "structured" as const, createdBy: "user", match: "all" as const };
  const [auto] = await t.db
    .insert(rules)
    .values({ ...base, name: "Text files", priority: 1, mode: "auto", conditions: [{ field: "ext", op: "is", value: "txt" }], actions: [{ type: "tag", value: "text" }] })
    .returning();
  const [suggest] = await t.db
    .insert(rules)
    .values({ ...base, name: "Markdown is notes", priority: 2, mode: "suggest", conditions: [{ field: "ext", op: "is", value: "md" }], actions: [{ type: "set_category", value: "Notes" }] })
    .returning();
  autoId = auto!.id;
  suggestId = suggest!.id;

  runtime = await startWorker({
    redisUrl,
    heartbeatEveryMs: 3_600_000,
    rulesTickEveryMs: 3_600_000,
    rulesDelayMs: 100,
    prefix: `fptest${Date.now()}r`,
    log: (msg, extra) => {
      if (msg === "job failed") console.log("FAILED", JSON.stringify(extra));
    },
    pipeline: pipeline(),
  });
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await t?.drop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("rules after a scan", () => {
  it("auto rules execute and suggest rules wait for approval", async () => {
    await scan();
    await until(async () => [await fileNamed("notes.txt"), await fileNamed("todo.txt")], (fs2) => fs2.every((f) => f?.tags.includes("text")));
    const tagEvents = await t.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, ORG), eq(auditEvents.action, "tag")));
    expect(tagEvents.map((e) => e.actor)).toEqual([`rule:${autoId}`, `rule:${autoId}`]);

    const pending = await until(pendingPlans, (p) => p.length === 1);
    expect(pending[0]).toMatchObject({ source: "rule", actor: `rule:${suggestId}`, spaceId });
    const steps = await t.db.select().from(planSteps).where(eq(planSteps.planId, pending[0]!.id));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: "category", toValue: "Notes", fileId: (await fileNamed("readme.md"))!.id });
    expect((await fileNamed("readme.md"))!.category).toBeNull();
    await until(async () => (await t.db.select().from(files).where(eq(files.organizationId, ORG))).every((f) => f.rulesCheckedAt !== null), Boolean);
  });

  it("re-scans and changed files don't create duplicate plans", async () => {
    await fs.writeFile(path.join(dir, "readme.md"), "# Read me, changed");
    await scan();
    await until(fileNamed.bind(null, "readme.md"), (f) => Boolean(f?.analyzedAt && f.rulesCheckedAt && f.rulesCheckedAt >= f.analyzedAt));
    await new Promise((r) => setTimeout(r, 500));
    expect(await pendingPlans()).toHaveLength(1);
    const tagEvents = await t.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, ORG), eq(auditEvents.action, "tag")));
    expect(tagEvents).toHaveLength(2);
  });
});

describe("scheduled rules", () => {
  it("run over the whole scope once per interval and record last_run_at", async () => {
    const [weekly] = await t.db
      .insert(rules)
      .values({ organizationId: ORG, type: "structured", createdBy: "user", name: "Weekly tidy", priority: 3, mode: "auto", schedule: "weekly", conditions: [{ field: "name", op: "contains", value: "o" }], actions: [{ type: "tag", value: "weekly" }] })
      .returning();
    const queued: RulesJob[] = [];
    const deps = { ...pipeline(), enqueueRules: async (j: RulesJob) => void queued.push(j) };
    const now = Date.now();
    const first = await rulesTick(deps, now);
    expect(first.scheduled).toHaveLength(1);
    expect(first.scheduled[0]!.outcomes[0]).toMatchObject({ ruleId: weekly!.id, mode: "auto", files: 2 });
    expect((await fileNamed("todo.txt"))!.tags).toContain("weekly");
    const [row] = await t.db.select().from(rules).where(eq(rules.id, weekly!.id));
    expect(row!.lastRunAt?.getTime()).toBe(now);

    const second = await rulesTick(deps, now + 60_000);
    expect(second.scheduled).toHaveLength(0);
    const later = await rulesTick(deps, now + 8 * 86_400_000);
    expect(later.scheduled).toHaveLength(1);
    expect(later.scheduled[0]!.outcomes).toEqual([]);
  });

  it("queues a rules run for spaces with files the rules haven't seen", async () => {
    await t.db.update(files).set({ rulesCheckedAt: null }).where(eq(files.organizationId, ORG));
    const queued: RulesJob[] = [];
    await rulesTick({ ...pipeline(), enqueueRules: async (j) => void queued.push(j) });
    expect(queued).toEqual([{ orgId: ORG, spaceId }]);
  });
});
