import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "./context";
import { inlineScriptHashes, mountWebApp } from "./web-app";

const INLINE = "console.log('theme')";
let app: Hono<AppEnv>;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp-web-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), `<html><head><script>${INLINE}</script><script type="module" src="/assets/app.js"></script></head></html>`);
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "export {}");
  fs.writeFileSync(path.join(root, "secret.txt"), "outside");
  app = new Hono<AppEnv>();
  app.get("/api/health", (c) => c.json({ ok: true }));
  mountWebApp(app, dist);
});

describe("web app from the API origin", () => {
  it("serves files, falls back to index.html for app routes, and leaves /api alone", async () => {
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    const route = await app.request("/connect/gdrive/123");
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<script");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true });
  });

  it("allows only its own scripts and the hashed inline one", async () => {
    const csp = (await app.request("/")).headers.get("content-security-policy")!;
    const hash = createHash("sha256").update(INLINE).digest("base64");
    expect(inlineScriptHashes(`<script>${INLINE}</script><script src="/x.js"></script>`)).toEqual([hash]);
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("never serves files outside the build folder", async () => {
    const res = await app.request("/..%2Fsecret.txt");
    expect(await res.text()).not.toContain("outside");
  });
});
