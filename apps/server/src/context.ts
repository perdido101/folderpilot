import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { AIProvider, AISettings } from "@folderpilot/ai";
import type { StorageAdapter } from "@folderpilot/core";
import type { Role } from "@folderpilot/core";
import type { Database, spaces } from "@folderpilot/db";
import type { Auth } from "./auth";
import type { Env } from "./env";
import type { Logger } from "./lib/logger";

export interface Deps {
  env: Env;
  db: Database;
  redis: Redis | null;
  auth: Auth;
  log: Logger;
  /** Parsed ENCRYPTION_KEY (org secrets at rest). */
  encryptionKey: Buffer;
  /** Job producers (null when Redis isn't reachable: scans can't be queued). */
  queues: { indexing: Queue } | null;
  ai: {
    /** FolderPilot AI with our key (null when ANTHROPIC_API_KEY isn't set). */
    hosted(): AIProvider | null;
    /** The provider an organization configured. */
    forOrg(settings: AISettings): AIProvider | null;
  };
  adapterFor(space: typeof spaces.$inferSelect): StorageAdapter;
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
