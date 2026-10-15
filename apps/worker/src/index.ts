import pino from "pino";
import { z } from "zod";
import { adapterForSpace } from "@folderpilot/adapters";
import { createDb, parseKey } from "@folderpilot/db";
import { startWorker } from "./worker";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    REDIS_URL: z.string().url(),
    DATABASE_URL: z.string().url(),
    ENCRYPTION_KEY: optional,
    LOG_LEVEL: z.string().default("info"),
    WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(60_000),
    ANTHROPIC_API_KEY: optional,
    FP_AI_ANALYSIS_MODEL: z.string().default("claude-haiku-5-5"),
    FP_AI_AGENT_MODEL: z.string().default("claude-opus-5-5"),
    FP_DEV_SAMPLE_DIR: optional,
    FP_QUEUE_PREFIX: z.string().default("bull"),
    OLLAMA_URL: optional,
    FP_EMBED_MODEL: optional,
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL });
if (!env.ENCRYPTION_KEY) {
  if (env.NODE_ENV === "production") throw new Error("ENCRYPTION_KEY is required in production (see .env.example).");
  log.warn("ENCRYPTION_KEY is not set — organization AI keys can't be read. Run `pnpm setup:env`.");
}
const { db, close } = createDb(env.DATABASE_URL, { max: 10 });
const runtime = await startWorker({
  redisUrl: env.REDIS_URL,
  heartbeatEveryMs: env.WORKER_HEARTBEAT_MS,
  prefix: env.FP_QUEUE_PREFIX,
  log: (msg, extra) => log.info(extra ?? {}, msg),
  pipeline: {
    db,
    encryptionKey: env.ENCRYPTION_KEY ? parseKey(env.ENCRYPTION_KEY) : Buffer.alloc(32),
    hosted: { apiKey: env.ANTHROPIC_API_KEY, analysisModel: env.FP_AI_ANALYSIS_MODEL, agentModel: env.FP_AI_AGENT_MODEL },
    embedFallback: { ollamaUrl: env.OLLAMA_URL, model: env.FP_EMBED_MODEL },
    adapterFor: (space) => adapterForSpace(space, { devSampleDir: env.FP_DEV_SAMPLE_DIR, production: env.NODE_ENV === "production" }),
  },
});
log.info({ workerId: runtime.workerId }, "FolderPilot worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "worker shutting down (finishing running jobs)");
    void runtime
      .stop()
      .then(close)
      .then(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
