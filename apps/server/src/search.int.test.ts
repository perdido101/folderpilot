/** The search API: org/space scoping, filters, facets, chips, words-only fallback, and the agent using it. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AIProvider, ChatEvent, ChatMessage, Embedder } from "@folderpilot/ai";
import { createTestDatabase, files, memberships, spaces, users, type TestDatabase } from "@folderpilot/db";
import { createApp } from "./app";
import { createDeps } from "./deps";
import { TestClient } from "./testing/client";

let t: TestDatabase;
let runtime: ReturnType<typeof createDeps>;
let orgId: string;
let spaceA: string;
let spaceB: string;
let owner: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let withEmbedder = false;
let lastAgentResult = "";

/** "bill" and "invoice" mean the same thing. */
const vec = (text: string) => {
  const v = new Array<number>(1024).fill(0);
  if (/bill|invoice/i.test(text)) v[1] = 1;
  if (/beach|holiday/i.test(text)) v[2] = 1;
  return v;
};
const fakeEmbedder: Embedder = { model: "fake:1", embed: async (texts) => texts.map(vec) };
const agentAI: AIProvider = {
  label: "Fake",
  cacheKey: "fake:1",
  describeImage: () => Promise.reject(new Error("unused")),
  describeText: () => Promise.reject(new Error("unused")),
  async *chat(_s, messages: ChatMessage[]) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      lastAgentResult = last.content;
      yield { type: "done", content: "Found it.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } satisfies ChatEvent;
    } else yield { type: "done", content: "", toolCalls: [{ id: "1", name: "search_files", input: { query: "bill" } }], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } satisfies ChatEvent;
  },
  test: async () => "ok",
};

const userId = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0]!.id;
async function addFile(space: string, path: string, extra: Partial<typeof files.$inferInsert> = {}) {
  const name = path.split("/").pop()!;
  const [row] = await t.db
    .insert(files)
    .values({ organizationId: orgId, spaceId: space, providerRef: path, path, name, ext: name.split(".").pop()!, size: 10, mtime: new Date("2026-02-01"), analyzedAt: new Date(), ...extra })
    .returning();
  await t.db.update(files).set({ embedding: vec(`${name} ${extra.caption ?? ""}`), embeddingModel: "fake:1" }).where(eq(files.id, row!.id));
  return row!;
}

beforeAll(async () => {
  t = await createTestDatabase("fp_search_api");
  runtime = createDeps(
    { NODE_ENV: "test", LOG_LEVEL: process.env.TEST_LOG ?? "silent", DATABASE_URL: t.url, REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379", FP_QUEUE_PREFIX: `fptest${Date.now()}s` },
    {},
    { ai: { hosted: () => null, forOrg: () => agentAI, embedderFor: () => (withEmbedder ? fakeEmbedder : null) } },
  );
  await runtime.start();
  const app = createApp(runtime.deps);
  owner = new TestClient(app, "10.4.0.1");
  viewer = new TestClient(app, "10.4.0.2");
  stranger = new TestClient(app, "10.4.0.3");
  await owner.signUp("so@example.com", "Owner");
  orgId = (await owner.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Search Co", slug: "search-co" } })).body.id;
  await viewer.signUp("sv@example.com", "Viewer");
  await stranger.signUp("ss@example.com", "Stranger");
  await stranger.json("/api/auth/organization/create", { body: { name: "Other", slug: "search-other" } });
  await t.db.insert(memberships).values({ id: randomUUID(), organizationId: orgId, userId: await userId("sv@example.com"), role: "viewer" });
  const [a, b] = await t.db
    .insert(spaces)
    .values([
      { organizationId: orgId, name: "Office", mode: "private", adapterId: "local-server", rootRef: "/a" },
      { organizationId: orgId, name: "Archive", mode: "private", adapterId: "local-server", rootRef: "/b" },
    ])
    .returning();
  spaceA = a!.id;
  spaceB = b!.id;
  await addFile(spaceA, "Finance/Invoice 1001.pdf", { category: "Invoices", entities: { client: "Alpha Ltd" }, textExcerpt: "INVOICE 1001 Alpha Ltd total" });
  await addFile(spaceA, "Photos/beach.jpg", { category: "Photos", caption: "Sunny beach" });
  await addFile(spaceB, "invoice-2019.pdf", { category: "Invoices", mtime: new Date("2019-04-01") });
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await t?.drop();
});

interface Res {
  results: { file: { name: string }; spaceName: string; matchedBy: string[]; snippet: string | null }[];
  total: number;
  semantic: string;
  chips: { type: string; value: string }[];
  facets?: { space: { name: string; count: number }[]; kind: { key: string; count: number }[] };
}

describe("search API", () => {
  it("searches every space of the organization by words, with snippets, chips and facets", async () => {
    const r = await viewer.json<Res>(`/api/orgs/${orgId}/search?q=${encodeURIComponent("invoice pdf")}&facets=1`);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x) => [x.file.name, x.spaceName])).toEqual([
      ["Invoice 1001.pdf", "Office"],
      ["invoice-2019.pdf", "Archive"],
    ]);
    expect(r.body.semantic).toBe("unavailable");
    expect(r.body.chips).toEqual([{ type: "ext", value: "pdf", raw: "pdf" }]);
    expect(r.body.results[0]!.snippet).toContain("[[");
    expect(r.body.facets!.space.map((s) => [s.name, s.count])).toEqual([
      ["Archive", 1],
      ["Office", 1],
    ]);
  });

  it("filters by space, date, client and kind", async () => {
    const names = async (qs: string) => (await owner.json<Res>(`/api/orgs/${orgId}/search?${qs}`)).body.results.map((x) => x.file.name);
    expect(await names(`q=invoice&spaceId=${spaceB}`)).toEqual(["invoice-2019.pdf"]);
    expect(await names(`q=invoice&from=2026-01-01`)).toEqual(["Invoice 1001.pdf"]);
    expect(await names(`q=invoice 2019`)).toEqual(["invoice-2019.pdf"]);
    expect(await names(`q=&client=alpha`)).toEqual(["Invoice 1001.pdf"]);
    expect(await names(`q=&kind=image`)).toEqual(["beach.jpg"]);
  });

  it("adds search by meaning when an embedding model is set up", async () => {
    withEmbedder = true;
    const r = await owner.json<Res>(`/api/orgs/${orgId}/search?q=bill`);
    expect(r.body.semantic).toBe("on");
    expect(r.body.results.map((x) => x.file.name).sort()).toEqual(["Invoice 1001.pdf", "invoice-2019.pdf"]);
    expect(r.body.results[0]!.matchedBy).toEqual(["meaning"]);
    const off = await owner.json<Res>(`/api/orgs/${orgId}/search?q=bill&semantic=0`);
    expect(off.body).toMatchObject({ semantic: "off", total: 0 });
  });

  it("the agent's search_files uses the same hybrid search, inside its space", async () => {
    withEmbedder = true;
    const res = await owner.req(`/api/orgs/${orgId}/spaces/${spaceA}/agent`, { body: { message: "find the bill" } });
    await res.text();
    const result = JSON.parse(lastAgentResult) as { searchedBy: string; files: { name: string; matchedBy: string }[] };
    expect(result.searchedBy).toBe("words and meaning");
    expect(result.files.map((f) => f.name)).toEqual(["Invoice 1001.pdf"]);
  });

  it("is scoped: other organizations get 404, unknown spaces 404, bad input 400", async () => {
    expect((await stranger.req(`/api/orgs/${orgId}/search?q=invoice`)).status).toBe(404);
    expect((await owner.req(`/api/orgs/${orgId}/search?q=x&spaceId=${randomUUID()}`)).status).toBe(404);
    expect((await owner.req(`/api/orgs/${orgId}/search?q=x&from=yesterday`)).status).toBe(400);
  });
});
