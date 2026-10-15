/** Connect Google Drive: OAuth (PKCE, single-use state), encrypted tokens, folder picker, choosing a folder, disconnect. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MockGoogle } from "@folderpilot/adapters/testing";
import { createTestDatabase, files, memberships, openCredentials, spaces, users, type TestDatabase } from "@folderpilot/db";
import { createApp } from "./app";
import { createDeps } from "./deps";
import { TestClient } from "./testing/client";

let t: TestDatabase;
let google: MockGoogle;
let runtime: ReturnType<typeof createDeps>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let owner: TestClient;
let editor: TestClient;
let stranger: TestClient;
let financeId: string;

const userId = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0]!.id;

/** Start → (mock) Google consent → callback. Returns the final redirect into the web app. */
async function connect(client: TestClient, query = "") {
  const start = await client.req(`/api/orgs/${orgId}/connect/gdrive/start${query}`);
  expect(start.status).toBe(302);
  const consent = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const back = new URL(consent.headers.get("location")!);
  expect(back.pathname).toBe("/api/connect/gdrive/callback");
  const done = await client.req(`${back.pathname}${back.search}`);
  expect(done.status).toBe(302);
  return { start: new URL(start.headers.get("location")!), callback: back, location: done.headers.get("location")! };
}

beforeAll(async () => {
  t = await createTestDatabase("fp_connect_api");
  google = new MockGoogle();
  await google.start();
  financeId = google.addFolder("Finance");
  google.addFolder("2026", financeId);
  google.addFolder("Photos");
  google.addFile("invoice.pdf", "INVOICE", financeId, { mimeType: "application/pdf" });
  runtime = createDeps({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG ?? "silent",
    DATABASE_URL: t.url,
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    FP_QUEUE_PREFIX: `fptest${Date.now()}c`,
    GOOGLE_CLIENT_ID: "client-1",
    GOOGLE_CLIENT_SECRET: "secret-1",
    GOOGLE_OAUTH_URL: google.urls.authUrl,
    GOOGLE_TOKEN_URL: google.urls.tokenUrl,
    GOOGLE_REVOKE_URL: google.urls.revokeUrl,
    GOOGLE_DRIVE_API: google.urls.apiBase,
  });
  await runtime.start();
  app = createApp(runtime.deps);
  owner = new TestClient(app, "10.6.0.1");
  editor = new TestClient(app, "10.6.0.2");
  stranger = new TestClient(app, "10.6.0.3");
  await owner.signUp("co@example.com", "Owner");
  orgId = (await owner.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Connect Co", slug: "connect-co" } })).body.id;
  await editor.signUp("ce@example.com", "Editor");
  await stranger.signUp("cs@example.com", "Stranger");
  await stranger.json("/api/auth/organization/create", { body: { name: "Other", slug: "connect-other" } });
  await t.db.insert(memberships).values({ id: randomUUID(), organizationId: orgId, userId: await userId("ce@example.com"), role: "editor" });
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await google?.stop();
  await t?.drop();
});

type SpaceItem = { id: string; name: string; adapterId: string; connected: boolean; needsFolder: boolean; needsReconnect: string | null; credentialsEncrypted?: unknown; settings: { account?: string; rootName?: string } };

describe("connect Google Drive", () => {
  let spaceId: string;

  it("is off for members who can't add sources and for other organizations", async () => {
    expect((await editor.req(`/api/orgs/${orgId}/connect/gdrive/start`)).status).toBe(403);
    expect((await stranger.req(`/api/orgs/${orgId}/connect/gdrive/start`)).status).toBe(404);
  });

  it("sends the owner to Google with the drive scope, offline access and PKCE, then creates the space", async () => {
    const { start, location } = await connect(owner);
    expect(start.searchParams.get("client_id")).toBe("client-1");
    expect(start.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive");
    expect(start.searchParams.get("access_type")).toBe("offline");
    expect(start.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/connect/gdrive/callback");

    const m = /\/connect\/gdrive\/([0-9a-f-]{36})$/.exec(location);
    expect(m).not.toBeNull();
    spaceId = m![1]!;
    const [row] = await t.db.select().from(spaces).where(eq(spaces.id, spaceId));
    expect(row).toMatchObject({ organizationId: orgId, mode: "connect", adapterId: "gdrive", rootRef: "", name: "Google Drive (you@example.com)" });
    // Encrypted at rest, bound to this space.
    expect(JSON.stringify(row!.credentialsEncrypted)).not.toContain("rt_");
    const creds = openCredentials(runtime.deps.encryptionKey, row!);
    expect(google.refreshTokens.has(creds!.tokens.refreshToken)).toBe(true);

    const list = await owner.json<SpaceItem[]>(`/api/orgs/${orgId}/spaces`);
    const item = list.body.find((s) => s.id === spaceId)!;
    expect(item).toMatchObject({ connected: true, needsFolder: true, needsReconnect: null, settings: { account: "you@example.com" } });
    expect(JSON.stringify(list.body)).not.toMatch(/credentialsEncrypted|rt_|at_/);
  });

  it("refuses a replayed, forged or someone else's state", async () => {
    const start = await owner.req(`/api/orgs/${orgId}/connect/gdrive/start`);
    const consent = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const back = new URL(consent.headers.get("location")!);
    // Another signed-in user can't finish my connection (and the state is used up by the attempt).
    const hijack = await stranger.req(`${back.pathname}${back.search}`);
    expect(hijack.headers.get("location")).toMatch(/\/connect\/gdrive\/error\?message=Please%20sign%20in/);
    const replay = await owner.req(`${back.pathname}${back.search}`);
    expect(replay.headers.get("location")).toMatch(/expired%20or%20was%20already%20used/);
    const forged = await owner.req(`/api/connect/gdrive/callback?code=x&state=nope`);
    expect(forged.headers.get("location")).toMatch(/\/connect\/gdrive\/error/);
  });

  it("explains a refused consent", async () => {
    const start = await owner.req(`/api/orgs/${orgId}/connect/gdrive/start`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await owner.req(`/api/connect/gdrive/callback?error=access_denied&state=${state}`);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("access was not allowed");
    const count = (await t.db.select().from(spaces).where(eq(spaces.organizationId, orgId))).length;
    expect(count).toBe(1);
  });

  it("lists Drive folders for the picker (admins only)", async () => {
    const top = await owner.json<{ name: string; folders: { id: string; name: string }[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/provider-folders`);
    expect(top.status).toBe(200);
    expect(top.body.name).toBe("My Drive");
    expect(top.body.folders.map((f) => f.name)).toEqual(["Finance", "Photos"]);
    const sub = await owner.json<{ name: string; folders: { name: string }[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/provider-folders?parent=${financeId}`);
    expect(sub.body).toMatchObject({ name: "Finance", folders: [{ name: "2026" }] });
    expect((await editor.req(`/api/orgs/${orgId}/spaces/${spaceId}/provider-folders`)).status).toBe(403);
    expect((await stranger.req(`/api/orgs/${orgId}/spaces/${spaceId}/provider-folders`)).status).toBe(404);
  });

  it("choosing a folder renames, resets the index and queues the first scan", async () => {
    await t.db.insert(files).values({ organizationId: orgId, spaceId, providerRef: "old", path: "old.txt", name: "old.txt", ext: "txt", size: 1, mtime: new Date() });
    const res = await owner.json<{ name: string; rootRef: string; settings: { rootName: string }; scanning: boolean }>(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "PATCH", body: { rootRef: financeId, name: "Finance Drive" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Finance Drive", rootRef: financeId, settings: { rootName: "Finance" }, scanning: true });
    expect(await t.db.select().from(files).where(eq(files.spaceId, spaceId))).toHaveLength(0);
    const jobs = await runtime.deps.queues!.indexing.getJobs(["waiting", "delayed", "active"]);
    expect(jobs.some((j) => j.data.spaceId === spaceId)).toBe(true);
    const list = await owner.json<SpaceItem[]>(`/api/orgs/${orgId}/spaces`);
    expect(list.body.find((s) => s.id === spaceId)!.needsFolder).toBe(false);

    expect((await owner.json(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "PATCH", body: { rootRef: "missing-folder" } })).status).toBe(404);
    expect((await editor.json(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "PATCH", body: { name: "x" } })).status).toBe(403);
    expect((await stranger.json(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "PATCH", body: { name: "x" } })).status).toBe(404);
  });

  it("reconnecting keeps the space and clears the reconnect banner", async () => {
    const [row] = await t.db.select().from(spaces).where(eq(spaces.id, spaceId));
    await t.db.update(spaces).set({ settings: { ...row!.settings, needsReconnect: "Access was revoked." } }).where(eq(spaces.id, spaceId));
    const { location } = await connect(owner, `?spaceId=${spaceId}`);
    expect(location).toContain(`/connect/gdrive/${spaceId}?reconnected=1`);
    const [after] = await t.db.select().from(spaces).where(eq(spaces.id, spaceId));
    expect(after!.settings.needsReconnect).toBeUndefined();
    expect(after!.rootRef).toBe(financeId);
  });

  it("disconnecting revokes access and removes the space — never the files in Drive", async () => {
    const [row] = await t.db.select().from(spaces).where(eq(spaces.id, spaceId));
    const refresh = openCredentials(runtime.deps.encryptionKey, row!)!.tokens.refreshToken;
    expect((await editor.req(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "DELETE" })).status).toBe(403);
    expect((await stranger.req(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "DELETE" })).status).toBe(404);
    const res = await owner.json<{ ok: boolean; revoked: boolean }>(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "DELETE" });
    expect(res.body).toEqual({ ok: true, revoked: true });
    expect(google.revoked).toContain(refresh);
    expect(await t.db.select().from(spaces).where(eq(spaces.id, spaceId))).toHaveLength(0);
    expect(google.byPath("Finance/invoice.pdf")).toBeDefined();
    expect(google.calls.some((c) => c.method === "DELETE" || /trash/.test(c.path))).toBe(false);
  });
});

describe("without Google credentials", () => {
  it("says Drive isn't configured", async () => {
    const plain = createDeps({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: t.url, REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379", FP_QUEUE_PREFIX: `fptest${Date.now()}n` });
    const client = new TestClient(createApp(plain.deps), "10.6.0.9");
    await client.signUp("cn@example.com", "Nobody");
    const org = (await client.json<{ id: string }>("/api/auth/organization/create", { body: { name: "No Google", slug: "no-google" } })).body.id;
    const res = await client.json<{ error?: string; message?: string }>(`/api/orgs/${org}/connect/gdrive/start`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("isn't configured");
    const sys = await client.json<{ connect: { gdrive: boolean } }>("/api/config/features");
    expect(sys.body.connect.gdrive).toBe(false);
  });
});
