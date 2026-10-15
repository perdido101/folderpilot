import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { memberships, scoped, spaces, users } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireOrg, requirePermission } from "../middleware/auth";

export function orgRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("/:orgId/*", requireOrg(deps));

  /** Connected sources (spaces) of the organization. Credentials are never returned. */
  app.get("/:orgId/spaces", requirePermission("file", "view"), async (c) => {
    const rows = await scoped(deps.db, c.get("org").id).select(spaces);
    return c.json(
      rows.map(({ credentialsEncrypted, syncCursor: _cursor, ...rest }) => ({
        ...rest,
        connected: credentialsEncrypted !== null || rest.adapterId === "local-browser" || rest.adapterId === "local-server",
        /** Connected but no folder chosen yet (Google Drive right after connecting). */
        needsFolder: rest.mode === "connect" && !rest.rootRef,
        needsReconnect: rest.settings.needsReconnect ?? null,
      })),
    );
  });

  /** Members and roles (admin+). */
  app.get("/:orgId/members", requirePermission("member", "update"), async (c) => {
    const rows = await deps.db
      .select({ id: memberships.id, userId: users.id, name: users.name, email: users.email, role: memberships.role, joinedAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, c.get("org").id))
      .orderBy(asc(users.name));
    return c.json(rows);
  });

  return app;
}
