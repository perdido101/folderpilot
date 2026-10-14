import { Redis } from "ioredis";
import { createDb } from "@folderpilot/db";
import { createAuth } from "./auth";
import type { Deps } from "./context";
import { loadEnv, type Env } from "./env";
import { createLogger } from "./lib/logger";

/** Build all runtime dependencies from the environment. */
export function createDeps(source: Record<string, string | undefined> = process.env, overrides: Partial<Env> = {}) {
  const log = createLogger(source.LOG_LEVEL ?? "info", source.NODE_ENV !== "production" && source.NODE_ENV !== "test" && process.stdout.isTTY);
  const env = { ...loadEnv(source, (m) => log.warn(m)), ...overrides };
  const { db, close } = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
  const deps: Deps = { env, db, redis, auth: createAuth(env, db, log), log };
  return {
    deps,
    async start() {
      await redis.connect().catch((err: Error) => log.warn({ err: err.message }, "redis not reachable — rate limiting falls back to memory"));
    },
    async stop() {
      redis.disconnect();
      await close();
    },
  };
}
