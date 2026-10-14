import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { isRole } from "@folderpilot/core";
import { memberships, organizations } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireUser } from "../middleware/auth";

export function meRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireUser);

  /** The signed-in user, their organizations with roles, and the active organization. */
  app.get("/", async (c) => {
    const user = c.get("user")!;
    const rows = await deps.db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(eq(memberships.userId, user.id))
      .orderBy(organizations.name);
    const orgs = rows.filter((r) => isRole(r.role));
    const active = c.get("activeOrganizationId");
    return c.json({
      user,
      organizations: orgs,
      activeOrganizationId: orgs.some((o) => o.id === active) ? active : (orgs[0]?.id ?? null),
    });
  });

  return app;
}
