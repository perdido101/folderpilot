import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { AppEnv, Deps } from "../context";
import { features } from "../env";

export function systemRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get("/health", async (c) => {
    const db = await deps.db
      .execute(sql`select 1`)
      .then(() => "ok" as const)
      .catch(() => "down" as const);
    const redis = deps.redis
      ? await deps.redis
          .ping()
          .then(() => "ok" as const)
          .catch(() => "down" as const)
      : ("down" as const);
    const ok = db === "ok" && redis === "ok";
    return c.json({ status: ok ? "ok" : "degraded", db, redis, version: "0.1.0" }, ok ? 200 : 503);
  });

  /** Public: tells the UI which integrations are configured so it can hide the rest. */
  app.get("/config/features", (c) => {
    const f = features(deps.env);
    // Drive can also be set up in the app (Admin → Google Drive), not only in the environment.
    return c.json({ ...f, connect: { ...f.connect, gdrive: Boolean(deps.google.current()) } });
  });

  return app;
}
