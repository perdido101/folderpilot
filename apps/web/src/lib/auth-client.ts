import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { ROLE_GRANTS, STATEMENTS } from "@folderpilot/core";

// Same access-control definition as the server (apps/server/src/auth.ts), so the client knows our roles.
const ac = createAccessControl({ ...defaultStatements, ...STATEMENTS });
const roles = {
  owner: ac.newRole({ ...ROLE_GRANTS.owner, team: ["create", "update", "delete"], ac: ["create", "read", "update", "delete"] }),
  admin: ac.newRole({ ...ROLE_GRANTS.admin, team: ["create", "update", "delete"], ac: ["create", "read", "update", "delete"] }),
  editor: ac.newRole({ ...ROLE_GRANTS.editor }),
  viewer: ac.newRole({ ...ROLE_GRANTS.viewer }),
};

/** Better Auth client (sign in/up, social login, organizations, invitations). Same-origin /api/auth. */
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}` : undefined,
  basePath: "/api/auth",
  plugins: [organizationClient({ ac, roles })],
});
