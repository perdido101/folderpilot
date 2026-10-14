import pino from "pino";
import { z } from "zod";
import { startWorker } from "./worker";

const env = z
  .object({
    REDIS_URL: z.string().url(),
    LOG_LEVEL: z.string().default("info"),
    WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(60_000),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL });
const runtime = await startWorker({ redisUrl: env.REDIS_URL, heartbeatEveryMs: env.WORKER_HEARTBEAT_MS, log: (msg, extra) => log.info(extra ?? {}, msg) });
log.info({ workerId: runtime.workerId }, "FolderPilot worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "worker shutting down (finishing running jobs)");
    void runtime.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
