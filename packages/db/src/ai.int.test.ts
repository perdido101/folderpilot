import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_AI_SETTINGS, type AIProvider, type FileInsight } from "@folderpilot/ai";
import { DEFAULT_THRESHOLDS } from "@folderpilot/core";
import { createTestDatabase, type TestDatabase } from "./testing";
import { organizations, orgSettings } from "./schema";
import { loadOrgSettings, saveOrgSettings, toPublic } from "./org-settings";
import { BudgetExceededError, describeMetered, usageThisMonth } from "./ai-service";

let t: TestDatabase;
const key = Buffer.alloc(32, 9);
const insight: FileInsight = { category: "Invoices", tags: [], caption: "c", suggestedName: "n", entities: { client: null, date: null, amount: null, docType: null }, confidence: 0.9, reason: "r" };

function fakeProvider(): AIProvider & { calls: number } {
  return {
    calls: 0,
    label: "Fake",
    cacheKey: "fake:model-1",
    async describeImage() {
      this.calls++;
      return { insight, usage: { inputTokens: 100, outputTokens: 20 }, model: "model-1" };
    },
    async describeText() {
      this.calls++;
      return { insight, usage: { inputTokens: 50, outputTokens: 10 }, model: "model-1" };
    },
    async *chat() {
      yield { type: "done" as const, content: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, model: "model-1" };
    },
    async test() {
      return "ok";
    },
  };
}
const meta = (sha?: string) => ({ name: "a.txt", path: "a.txt", ext: "txt", size: 1, mtime: 0, flags: [], ...(sha ? { sha256: sha } : {}) });
const ctx = { knownCategories: [], naturalRules: [] };

beforeAll(async () => {
  t = await createTestDatabase("fp_ai");
  await t.db.insert(organizations).values([
    { id: "org_a", name: "A", slug: "a" },
    { id: "org_b", name: "B", slug: "b" },
  ]);
}, 60_000);
afterAll(async () => t?.drop());

describe("org settings", () => {
  it("stores keys encrypted, never returns them, and keeps a key when the browser sends it back empty", async () => {
    await saveOrgSettings(t.db, "org_a", key, {
      ai: { ...DEFAULT_AI_SETTINGS, provider: "anthropic", anthropic: { ...DEFAULT_AI_SETTINGS.anthropic, apiKey: "sk-ant-secret" } },
      thresholds: DEFAULT_THRESHOLDS,
      aiMonthlyFileBudget: 50,
    });
    const [row] = await t.db.select().from(orgSettings).where(eq(orgSettings.organizationId, "org_a"));
    expect(JSON.stringify(row)).not.toContain("sk-ant-secret");
    expect(row!.aiSecretsEncrypted).toMatch(/^v1:/);

    const loaded = await loadOrgSettings(t.db, "org_a", key);
    expect(loaded.ai.anthropic.apiKey).toBe("sk-ant-secret");
    const pub = toPublic(loaded);
    expect(pub.ai.anthropic.apiKey).toBe("");
    expect(pub.secretsSet["anthropic.apiKey"]).toBe(true);

    // The settings page sends the key back as "" → keep it; clearing is explicit.
    await saveOrgSettings(t.db, "org_a", key, { ...pub, ai: { ...pub.ai, anthropic: { ...pub.ai.anthropic, model: "claude-sonnet-5-5" } } });
    expect((await loadOrgSettings(t.db, "org_a", key)).ai.anthropic).toMatchObject({ apiKey: "sk-ant-secret", model: "claude-sonnet-5-5" });
    await saveOrgSettings(t.db, "org_a", key, pub, ["anthropic.apiKey"]);
    expect((await loadOrgSettings(t.db, "org_a", key)).ai.anthropic.apiKey).toBe("");
  });

  it("secrets are bound to their organization (copying the ciphertext to another org fails)", async () => {
    await saveOrgSettings(t.db, "org_a", key, { ai: { ...DEFAULT_AI_SETTINGS, openai: { ...DEFAULT_AI_SETTINGS.openai, apiKey: "sk-a" } }, thresholds: DEFAULT_THRESHOLDS, aiMonthlyFileBudget: 10 });
    const [a] = await t.db.select().from(orgSettings).where(eq(orgSettings.organizationId, "org_a"));
    await t.db.insert(orgSettings).values({ organizationId: "org_b", ai: {}, aiSecretsEncrypted: a!.aiSecretsEncrypted });
    await expect(loadOrgSettings(t.db, "org_b", key)).rejects.toThrow();
  });

  it("defaults: no AI, standard thresholds, 1,000 files a month", async () => {
    await t.db.insert(organizations).values({ id: "org_c", name: "C", slug: "c" });
    expect(await loadOrgSettings(t.db, "org_c", key)).toMatchObject({ ai: { provider: "none" }, thresholds: DEFAULT_THRESHOLDS, aiMonthlyFileBudget: 1000 });
  });
});

describe("metered AI", () => {
  it("caches by content hash and provider, records usage, and stops at the monthly budget", async () => {
    const p = fakeProvider();
    const first = await describeMetered(t.db, "org_c", p, { kind: "text", text: "x", meta: meta("sha-1"), ctx }, 2);
    expect(first.cached).toBe(false);
    const again = await describeMetered(t.db, "org_c", p, { kind: "text", text: "x", meta: meta("sha-1"), ctx }, 2);
    expect(again).toMatchObject({ cached: true, insight: { category: "Invoices" } });
    expect(p.calls).toBe(1);

    await describeMetered(t.db, "org_c", p, { kind: "text", text: "y", meta: meta("sha-2"), ctx }, 2);
    expect(await usageThisMonth(t.db, "org_c")).toMatchObject({ files: 2, inputTokens: 100, outputTokens: 20 });

    await expect(describeMetered(t.db, "org_c", p, { kind: "text", text: "z", meta: meta("sha-3"), ctx }, 2)).rejects.toBeInstanceOf(BudgetExceededError);
    // Cached content is still free after the budget is used up.
    expect((await describeMetered(t.db, "org_c", p, { kind: "text", text: "x", meta: meta("sha-1"), ctx }, 2)).cached).toBe(true);
    // Another organization doesn't see this cache or usage.
    expect((await describeMetered(t.db, "org_b", p, { kind: "text", text: "x", meta: meta("sha-1"), ctx }, 2)).cached).toBe(false);
  });
});
