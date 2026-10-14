import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { can, isRole, type Action, type Resource } from "@folderpilot/core";
import { memberships } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";

/** Resolve the Better Auth session (cookie) into c.var.user. Never throws. */
export function session(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    c.set("user", result ? { id: result.user.id, email: result.user.email, name: result.user.name } : null);
    c.set("activeOrganizationId", (result?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ?? null);
    await next();
  };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) throw new HTTPException(401, { message: "Please sign in." });
  await next();
};

/**
 * Org-scoped routes: the caller must be a member of :orgId. Non-members get 404
 * (not 403) so organization ids can't be probed.
 */
export function requireOrg(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "Please sign in." });
    const orgId = c.req.param("orgId");
    if (!orgId) throw new HTTPException(400, { message: "Missing organization." });
    const [m] = await deps.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, user.id)))
      .limit(1);
    if (!m || !isRole(m.role)) throw new HTTPException(404, { message: "Organization not found." });
    c.set("org", { id: orgId, role: m.role });
    await next();
  };
}

/** Use after requireOrg(). */
export function requirePermission<R extends Resource>(resource: R, action: Action<R>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const org = c.get("org");
    if (!can(org.role, resource, action)) throw new HTTPException(403, { message: "Your role doesn't allow this." });
    await next();
  };
}
