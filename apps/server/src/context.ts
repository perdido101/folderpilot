import type { Redis } from "ioredis";
import type { Role } from "@folderpilot/core";
import type { Database } from "@folderpilot/db";
import type { Auth } from "./auth";
import type { Env } from "./env";
import type { Logger } from "./lib/logger";

export interface Deps {
  env: Env;
  db: Database;
  redis: Redis | null;
  auth: Auth;
  log: Logger;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface AppVariables {
  requestId: string;
  user: SessionUser | null;
  activeOrganizationId: string | null;
  /** Set by requireOrg(): the org from the route and the caller's role in it. */
  org: { id: string; role: Role };
}

export type AppEnv = { Variables: AppVariables };
