import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { StorageError } from "@folderpilot/core";
import type { AppEnv, Deps } from "./context";
import { session } from "./middleware/auth";
import { originGuard } from "./middleware/origin";
import { rateLimit } from "./middleware/rate-limit";
import { meRoutes } from "./routes/me";
import { aiRoutes } from "./routes/ai";
import { orgRoutes } from "./routes/orgs";
import { ruleRoutes } from "./routes/rules";
import { agentRoutes } from "./routes/agent";
import { searchRoutes } from "./routes/search";
import { connectRoutes } from "./routes/connect";
import { mountWebApp } from "./web-app";
import { spaceFileRoutes } from "./routes/space-files";
import { systemRoutes } from "./routes/system";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { env, log } = deps;

  app.use("*", requestId());
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    log.info({ requestId: c.get("requestId"), method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - start) }, "request");
  });
  app.use(
    "/api/*",
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      crossOriginResourcePolicy: "same-site",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );
  app.use("/api/*", cors({ origin: env.APP_URL, credentials: true, allowHeaders: ["Content-Type", "Authorization"], maxAge: 600 }));
  // CSRF: state-changing requests from a browser must come from our own origins (any content type).
  app.use("/api/*", originGuard([env.APP_URL, env.API_URL]));
  app.use("/api/auth/*", rateLimit(deps.redis, { prefix: "auth", windowSec: 60, max: env.NODE_ENV === "test" ? 1000 : 30 }));
  app.use("/api/*", rateLimit(deps.redis, { prefix: "api", windowSec: 60, max: 600 }));

  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));

  app.use("/api/*", session(deps));
  app.route("/api", systemRoutes(deps));
  app.route("/api/me", meRoutes(deps));
  app.route("/api/orgs", orgRoutes(deps));
  app.route("/api/orgs", aiRoutes(deps));
  app.route("/api/orgs", spaceFileRoutes(deps));
  app.route("/api/orgs", ruleRoutes(deps));
  app.route("/api/orgs", agentRoutes(deps));
  app.route("/api/orgs", searchRoutes(deps));
  app.route("/api", connectRoutes(deps));
  // Single-service deployments: the web app from the same origin (its own CSP, see web-app.ts).
  if (env.FP_WEB_DIST) mountWebApp(app, env.FP_WEB_DIST);

  app.notFound((c) => c.json({ error: "not_found", message: "Not found." }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: "http_error", message: err.message }, err.status);
    // Errors from a storage provider (e.g. Google Drive) carry a meaning the UI can show.
    if (err instanceof StorageError) {
      if (err.name === "DriveAuthError") return c.json({ error: "needs_reconnect", message: "Google Drive access was revoked or expired. Reconnect this space." }, 409);
      const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "read_only" ? 403 : 502;
      if (status === 502) log.warn({ requestId: c.get("requestId"), err: err.message }, "storage provider error");
      return c.json({ error: err.code, message: err.message }, status);
    }
    log.error({ requestId: c.get("requestId"), err: { message: err.message, stack: env.NODE_ENV === "production" ? undefined : err.stack } }, "unhandled error");
    return c.json({ error: "internal", message: "Something went wrong.", requestId: c.get("requestId") }, 500);
  });

  return app;
}
