import type { Role } from "./types";

/**
 * Permission statements (resource → actions). Shared by the server (Better Auth access control,
 * route guards) and the web app (hiding actions a role can't perform).
 * Note: there is no "delete file" permission anywhere — trash (recoverable) is the strongest action,
 * and only humans can perform it (enforced again by the action engine).
 */
export const STATEMENTS = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  space: ["create", "update", "disconnect"],
  file: ["view", "organize", "trash", "restore"],
  plan: ["propose", "approve"],
  rule: ["manage"],
  settings: ["manage"],
  billing: ["manage"],
  audit: ["view", "export"],
  apiKey: ["manage"],
} as const;

export type Resource = keyof typeof STATEMENTS;
export type Action<R extends Resource> = (typeof STATEMENTS)[R][number];
export type RoleGrants = { [R in Resource]?: readonly Action<R>[] };

const ALL: RoleGrants = STATEMENTS;

export const ROLE_GRANTS: Record<Role, RoleGrants> = {
  owner: ALL,
  admin: {
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    space: ["create", "update", "disconnect"],
    file: ["view", "organize", "trash", "restore"],
    plan: ["propose", "approve"],
    rule: ["manage"],
    settings: ["manage"],
    audit: ["view", "export"],
    apiKey: ["manage"],
  },
  editor: {
    file: ["view", "organize", "trash", "restore"],
    plan: ["propose", "approve"],
    rule: ["manage"],
    audit: ["view"],
    apiKey: ["manage"],
  },
  viewer: {
    file: ["view"],
    plan: ["propose"],
    audit: ["view"],
  },
};

export function can<R extends Resource>(role: Role, resource: R, action: Action<R>): boolean {
  const grants = ROLE_GRANTS[role][resource] as readonly string[] | undefined;
  return grants?.includes(action) ?? false;
}

export function isRole(value: unknown): value is Role {
  return value === "owner" || value === "admin" || value === "editor" || value === "viewer";
}
