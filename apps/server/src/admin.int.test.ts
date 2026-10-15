/** Admin → Google Drive: the server admin pastes the Google keys in the app (checked with Google, stored encrypted). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockGoogle } from "@folderpilot/adapters/testing";
import { createTestDatabase, GoogleOAuthSource, serverSettings, type TestDatabase } from "@folderpilot/db";
import { createApp } from "./app";
import { createDeps } from "./deps";
import { TestClient } from "./testing/client";

const CLIENT_ID = "1234-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-test-secret";

let t: TestDatabase;
let google: MockGoogle;
let runtime: ReturnType<typeof createDeps>;
let admin: TestClient;
let member: TestClient;
let orgId: string;

const baseEnv = () => ({
  NODE_ENV: "test",
  LOG_LEVEL: process.env.TEST_LOG ?? "silent",
  DATABASE_URL: t.url,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  FP_QUEUE_PREFIX: `fptest${Date.now()}a`,
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  API_URL: "http://localhost:3000",
  APP_URL: "http://localhost:5173",
  GOOGLE_OAUTH_URL: google.urls.authUrl,
  GOOGLE_TOKEN_URL: google.urls.tokenUrl,
  GOOGLE_REVOKE_URL: google.urls.revokeUrl,
  GOOGLE_DRIVE_API: google.urls.apiBase,
});

type GoogleSetup = { isServerAdmin: boolean; configured: boolean; source: string | null; clientId: string | null; origin: string; redirectUris: string[] };

beforeAll(async () => {
  t = await createTestDatabase("fp_admin_api");
  google = new MockGoogle();
  google.client = { id: CLIENT_ID, secret: SECRET };
  await google.start();
  runtime = createDeps(baseEnv());
  await runtime.start();
  const app = createApp(runtime.deps);
  admin = new TestClient(app, "10.7.0.1");
  member = new TestClient(app, "10.7.0.2");
  await admin.signUp("first@example.com", "First"); // the first account on the server
  orgId = (await admin.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Admin Co", slug: "admin-co" } })).body.id;
  await member.signUp("second@example.com", "Second");
  await member.json("/api/auth/organization/create", { body: { name: "Other Co", slug: "admin-other" } });
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await google?.stop();
  await t?.drop();
});

describe("Admin → Google Drive", () => {
  it("shows the exact addresses to paste into Google, and who may change the keys", async () => {
    const a = await admin.json<GoogleSetup>("/api/admin/google");
    expect(a.body).toMatchObject({ isServerAdmin: true, configured: false, source: null, origin: "http://localhost:5173" });
    expect(a.body.redirectUris).toEqual(["http://localhost:3000/api/connect/gdrive/callback", "http://localhost:3000/api/auth/callback/google"]);
    expect((await member.json<GoogleSetup>("/api/admin/google")).body.isServerAdmin).toBe(false);
    expect((await admin.json<{ connect: { gdrive: boolean } }>("/api/config/features")).body.connect.gdrive).toBe(false);
    expect((await admin.req(`/api/orgs/${orgId}/connect/gdrive/start`)).status).toBe(409);
  });

  it("refuses non-admins, malformed keys and keys Google doesn't know", async () => {
    expect((await member.json("/api/admin/google", { method: "PUT", body: { clientId: CLIENT_ID, clientSecret: SECRET } })).status).toBe(403);
    const malformed = await admin.json<{ message: string }>("/api/admin/google", { method: "PUT", body: { clientId: "my-project", clientSecret: SECRET } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).toMatch(/apps\.googleusercontent\.com/);
    const wrong = await admin.json<{ message: string }>("/api/admin/google", { method: "PUT", body: { clientId: CLIENT_ID, clientSecret: "GOCSPX-wrong-secret" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/doesn't recognize/);
  });

  it("saves verified keys encrypted, turns Drive on, and other processes pick them up", async () => {
    const res = await admin.json<{ ok: boolean; verified: boolean }>("/api/admin/google", { method: "PUT", body: { clientId: ` ${CLIENT_ID} `, clientSecret: SECRET } });
    expect(res.body).toEqual({ ok: true, verified: true, configured: true });
    const [row] = await t.db.select().from(serverSettings);
    expect(row!.valueEncrypted).not.toContain(SECRET);
    expect(row!.valueEncrypted).not.toContain(CLIENT_ID);

    const view = await admin.json<GoogleSetup>("/api/admin/google");
    expect(view.body).toMatchObject({ configured: true, source: "app", clientId: CLIENT_ID });
    expect(JSON.stringify(view.body)).not.toContain(SECRET);
    expect((await member.json<GoogleSetup>("/api/admin/google")).body.clientId).toBeNull();
    expect((await admin.json<{ connect: { gdrive: boolean } }>("/api/config/features")).body.connect.gdrive).toBe(true);

    const start = await admin.req(`/api/orgs/${orgId}/connect/gdrive/start`);
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location")!).searchParams.get("client_id")).toBe(CLIENT_ID);

    // The worker (another process) reads the same keys.
    const other = new GoogleOAuthSource(t.db, runtime.deps.encryptionKey, {});
    expect(await other.refresh()).toMatchObject({ clientId: CLIENT_ID, clientSecret: SECRET, source: "app" });
  });

  it("removing the keys turns Drive off again", async () => {
    expect((await member.req("/api/admin/google", { method: "DELETE" })).status).toBe(403);
    expect((await admin.json("/api/admin/google", { method: "DELETE" })).status).toBe(200);
    expect((await admin.json<{ connect: { gdrive: boolean } }>("/api/config/features")).body.connect.gdrive).toBe(false);
  });

  it("keys from the environment win and can't be changed in the app", async () => {
    const envDeps = createDeps({ ...baseEnv(), GOOGLE_CLIENT_ID: "env-id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "env-secret-123" });
    await envDeps.start();
    try {
      const client = new TestClient(createApp(envDeps.deps), "10.7.0.9");
      await client.signUp("env@example.com", "Env"); // not the first account
      const view = await client.json<GoogleSetup>("/api/admin/google");
      expect(view.body).toMatchObject({ configured: true, source: "env", isServerAdmin: false });
      const res = await admin.json("/api/admin/google", { method: "PUT", body: { clientId: CLIENT_ID, clientSecret: SECRET } });
      expect(res.status).toBe(200); // the first server (no env keys) still accepts
      const envAdmin = new TestClient(createApp(envDeps.deps), "10.7.0.10");
      await envAdmin.json("/api/auth/sign-in/email", { body: { email: "first@example.com", password: "correct-horse-battery" } });
      expect((await envAdmin.json("/api/admin/google", { method: "PUT", body: { clientId: CLIENT_ID, clientSecret: SECRET } })).status).toBe(409);
    } finally {
      await envDeps.stop();
    }
  });
});
