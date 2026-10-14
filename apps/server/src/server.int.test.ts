import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@folderpilot/db";
import { createApp } from "./app";
import { createDeps } from "./deps";

const ORIGIN = "http://localhost:5173";
let t: TestDatabase;
let runtime: ReturnType<typeof createDeps>;
let app: ReturnType<typeof createApp>;

/** Minimal cookie jar around app.request(). */
class Client {
  private cookies = new Map<string, string>();
  async req(path: string, init: { method?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { Origin: ORIGIN, "x-forwarded-for": "10.0.0.1" };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method: init.method ?? (init.body ? "POST" : "GET"), headers, body: init.body ? JSON.stringify(init.body) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      this.cookies.set(k!, v.join("="));
    }
    return res;
  }
  async json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
    const res = await this.req(path, init);
    return { status: res.status, body: (await res.json()) as T };
  }
  signUp(email: string, name: string) {
    return this.json("/api/auth/sign-up/email", { body: { email, name, password: "correct-horse-battery" } });
  }
}

interface Me {
  user: { id: string; email: string };
  organizations: { id: string; name: string; role: string }[];
  activeOrganizationId: string | null;
}

beforeAll(async () => {
  t = await createTestDatabase("fp_server");
  runtime = createDeps({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: t.url, REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379" });
  await runtime.start();
  app = createApp(runtime.deps);
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await t?.drop();
});

describe("system", () => {
  it("reports health of Postgres and Redis", async () => {
    const res = await new Client().json<{ status: string; db: string; redis: string }>("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "ok", redis: "ok" });
  });

  it("reports every external integration as not configured", async () => {
    const res = await new Client().json<Record<string, unknown>>("/api/config/features");
    expect(res.body).toMatchObject({ auth: { email: true, google: false, microsoft: false }, cloudStorage: false, billing: false, folderpilotAI: false });
  });

  it("sets security headers and JSON 404s", async () => {
    const res = await new Client().req("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("auth, organizations and roles", () => {
  const owner = new Client();
  const viewer = new Client();
  const stranger = new Client();
  let orgId = "";

  it("requires a session for /api/me", async () => {
    expect((await new Client().req("/api/me")).status).toBe(401);
  });

  it("sign up → create organization → /api/me shows the owner role", async () => {
    expect((await owner.signUp("owner@example.com", "Olga")).status).toBe(200);
    const created = await owner.json<{ id: string }>("/api/auth/organization/create", { body: { name: "Alpha Accounting", slug: "alpha-accounting" } });
    expect(created.status).toBe(200);
    orgId = created.body.id;
    const me = await owner.json<Me>("/api/me");
    expect(me.body.organizations).toEqual([{ id: orgId, name: "Alpha Accounting", slug: "alpha-accounting", role: "owner" }]);
    expect(me.body.activeOrganizationId).toBe(orgId);
  });

  it("invites a viewer who accepts and gets viewer permissions only", async () => {
    const inv = await owner.json<{ id: string }>("/api/auth/organization/invite-member", { body: { email: "viewer@example.com", role: "viewer", organizationId: orgId } });
    expect(inv.status).toBe(200);
    await viewer.signUp("viewer@example.com", "Vasilis");
    const accepted = await viewer.json("/api/auth/organization/accept-invitation", { body: { invitationId: inv.body.id } });
    expect(accepted.status).toBe(200);
    const me = await viewer.json<Me>("/api/me");
    expect(me.body.organizations[0]).toMatchObject({ id: orgId, role: "viewer" });

    expect((await viewer.req(`/api/orgs/${orgId}/spaces`)).status).toBe(200);
    const denied = await viewer.json<{ message: string }>(`/api/orgs/${orgId}/members`);
    expect(denied.status).toBe(403);
    const members = await owner.json<{ email: string; role: string }[]>(`/api/orgs/${orgId}/members`);
    expect(members.status).toBe(200);
    expect(members.body.map((m) => [m.email, m.role]).sort()).toEqual([
      ["owner@example.com", "owner"],
      ["viewer@example.com", "viewer"],
    ]);
  });

  it("hides organizations from non-members (404, not 403)", async () => {
    await stranger.signUp("stranger@example.com", "Stavros");
    expect((await stranger.req(`/api/orgs/${orgId}/spaces`)).status).toBe(404);
  });

  it("blocks cross-site state-changing requests, whatever the content type", async () => {
    const json = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "x@example.com", password: "correct-horse-battery", name: "X" }),
    });
    expect(json.status).toBe(403);
    const form = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { Origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "name=Evil&slug=evil",
    });
    expect(form.status).toBe(403);
    const referer = await app.request("/api/auth/sign-out", { method: "POST", headers: { Referer: "https://evil.example/page" } });
    expect(referer.status).toBe(403);
  });

  it("allows our own origin and non-browser clients without Origin", async () => {
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "correct-horse-battery" }),
    });
    expect(res.status).toBe(200);
  });
});
