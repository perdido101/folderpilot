/**
 * Serves the built web app (apps/web/dist) from the API's own origin, for single-service deployments
 * (FP_WEB_DIST). Same origin = no CORS and first-party cookies. Every non-/api path that isn't a file
 * gets index.html (client-side routes). Inline scripts are allowed by hash only.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "./context";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** CSP for the app: own scripts (+ hashed inline ones), blob previews/workers, and AI endpoints the browser may call directly (folders on this device). */
export function webCsp(inlineHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineHashes.map((h) => `'sha256-${h}'`).join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => createHash("sha256").update(m[1]!).digest("base64"));
}

export function mountWebApp(app: Hono<AppEnv>, distDir: string) {
  const root = path.resolve(distDir);
  const indexPath = path.join(root, "index.html");
  if (!fs.existsSync(indexPath)) throw new Error(`FP_WEB_DIST: no index.html in ${root} (run \`pnpm build\` first).`);
  const indexHtml = fs.readFileSync(indexPath, "utf8");
  const csp = webCsp(inlineScriptHashes(indexHtml));
  const security = {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };

  app.get("*", (c, next) => {
    const reqPath = decodeURIComponent(c.req.path);
    if (reqPath === "/api" || reqPath.startsWith("/api/")) return next();
    const file = path.resolve(root, `.${reqPath}`);
    // Never serve anything outside the build folder.
    if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const hashed = reqPath.startsWith("/assets/");
      return new Response(fs.readFileSync(file), {
        headers: {
          ...security,
          "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "cache-control": hashed ? "public, max-age=31536000, immutable" : "public, max-age=300",
        },
      });
    }
    // Missing build assets are real 404s; everything else is a client-side route.
    if (reqPath.startsWith("/assets/")) return c.text("Not found", 404);
    return new Response(indexHtml, { headers: { ...security, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  });
}
