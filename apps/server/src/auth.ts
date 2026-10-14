import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { ROLE_GRANTS, STATEMENTS } from "@folderpilot/core";
import { accounts, invitations, memberships, organizations, sessions, users, verifications, type Database } from "@folderpilot/db";
import type { Env } from "./env";
import type { Logger } from "./lib/logger";

/** Better Auth's built-in org statements (team/ac used internally) + FolderPilot's own. */
const ac = createAccessControl({ ...defaultStatements, ...STATEMENTS });

const roles = {
  owner: ac.newRole({ ...ROLE_GRANTS.owner, team: ["create", "update", "delete"], ac: ["create", "read", "update", "delete"] }),
  admin: ac.newRole({ ...ROLE_GRANTS.admin, team: ["create", "update", "delete"], ac: ["create", "read", "update", "delete"] }),
  editor: ac.newRole({ ...ROLE_GRANTS.editor }),
  viewer: ac.newRole({ ...ROLE_GRANTS.viewer }),
};

export function createAuth(env: Env, db: Database, log: Logger) {
  const socialProviders: Parameters<typeof betterAuth>[0]["socialProviders"] = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    socialProviders.microsoft = { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenantId: env.MICROSOFT_TENANT ?? "common" };
  }

  return betterAuth({
    appName: "FolderPilot",
    baseURL: env.API_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { users, sessions, accounts, verifications, organizations, memberships, invitations },
    }),
    user: { modelName: "users" },
    session: { modelName: "sessions", expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    account: { modelName: "accounts", accountLinking: { enabled: true, trustedProviders: ["google", "microsoft"] } },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      // No mail service is configured yet: links are written to the server log in development.
      sendResetPassword: async ({ user, url }) => log.info({ userId: user.id, url }, "password reset link (email delivery not configured)"),
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => log.info({ userId: user.id, url }, "email verification link (email delivery not configured)"),
    },
    socialProviders,
    // Better Auth's own limiter runs in addition to our Redis-backed middleware.
    rateLimit: { enabled: env.NODE_ENV === "production", window: 60, max: 100 },
    advanced: {
      cookiePrefix: "fp",
      useSecureCookies: env.NODE_ENV === "production",
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "owner",
        allowUserToCreateOrganization: true,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "memberships" },
          invitation: { modelName: "invitations" },
        },
        sendInvitationEmail: async ({ id, email, role, organization: org }) => {
          log.info({ invitationId: id, email, role, organizationId: org.id, url: `${env.APP_URL}/invite/${id}` }, "invitation link (email delivery not configured)");
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
