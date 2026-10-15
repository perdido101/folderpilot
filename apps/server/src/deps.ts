import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { adapterForSpace } from "@folderpilot/adapters";
import { createServerProvider, embedderFor, folderPilotAI, type HostedAIConfig } from "@folderpilot/ai/server";
import { QUEUES } from "@folderpilot/core";
import { createDb, openCredentials, parseKey, saveSpaceTokens } from "@folderpilot/db";
import { createAuth } from "./auth";
import type { Deps } from "./context";
import { loadEnv, type Env } from "./env";
import { createLogger } from "./lib/logger";

/** Build all runtime dependencies from the environment. `replace` swaps parts out in tests (e.g. a fake AI). */
export function createDeps(source: Record<string, string | undefined> = process.env, overrides: Partial<Env> = {}, replace: { ai?: Partial<Deps["ai"]>; adapterFor?: Deps["adapterFor"] } = {}) {
  const log = createLogger(source.LOG_LEVEL ?? "info", source.NODE_ENV !== "production" && source.NODE_ENV !== "test" && process.stdout.isTTY);
  const env = { ...loadEnv(source, (m) => log.warn(m)), ...overrides };
  const { db, close } = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
  // BullMQ needs its own connection with maxRetriesPerRequest = null.
  const queueConnection = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  queueConnection.on("error", (err) => log.warn({ err: err.message }, "queue redis error"));
  const indexing = new Queue(QUEUES.indexing, { connection: queueConnection, prefix: env.FP_QUEUE_PREFIX });
  const encryptionKey = parseKey(env.ENCRYPTION_KEY);
  const hosted: HostedAIConfig = { apiKey: env.ANTHROPIC_API_KEY, analysisModel: env.FP_AI_ANALYSIS_MODEL, agentModel: env.FP_AI_AGENT_MODEL };
  const deps: Deps = {
    env,
    db,
    redis,
    auth: createAuth(env, db, log),
    log,
    encryptionKey,
    queues: { indexing },
    ai: {
      hosted: () => folderPilotAI(hosted),
      forOrg: (s) => createServerProvider(s, hosted),
      embedderFor: (s) => embedderFor(s, { ollamaUrl: env.OLLAMA_URL, model: env.FP_EMBED_MODEL }),
      ...replace.ai,
    },
    adapterFor:
      replace.adapterFor ??
      ((space) =>
        adapterForSpace(space, {
          devSampleDir: env.FP_DEV_SAMPLE_DIR,
          production: env.NODE_ENV === "production",
          google: googleConfig(env),
          credentials: {
            open: (s) => openCredentials(encryptionKey, { id: s.id!, credentialsEncrypted: s.credentialsEncrypted ?? null }),
            save: (s, tokens) => saveSpaceTokens(db, encryptionKey, s.id!, tokens),
          },
          ...(env.NODE_ENV === "test" ? { backoffMs: 1 } : {}),
        })),
  };
  return {
    deps,
    async start() {
      await redis.connect().catch((err: Error) => log.warn({ err: err.message }, "redis not reachable — rate limiting falls back to memory"));
      // BullMQ connects by itself; give it a moment, and run without queues if Redis is down.
      const ready = await Promise.race([indexing.waitUntilReady().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]).catch(() => false);
      if (!ready) {
        log.warn("job queue not reachable — scans can't be queued");
        deps.queues = null;
      }
    },
    async stop() {
      await indexing.close().catch(() => undefined);
      redis.disconnect();
      queueConnection.disconnect();
      await close();
    },
  };
}

/** Google OAuth client for Drive (null when GOOGLE_CLIENT_ID/SECRET aren't set: Drive stays hidden). */
export function googleConfig(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, tokenUrl: env.GOOGLE_TOKEN_URL, apiBase: env.GOOGLE_DRIVE_API };
}
