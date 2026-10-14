import { hostname } from "node:os";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES } from "@folderpilot/core";
import { systemProcessor } from "./processors";

export interface WorkerRuntime {
  workerId: string;
  systemQueue: Queue;
  stop(): Promise<void>;
}

export interface WorkerOptions {
  redisUrl: string;
  heartbeatEveryMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Start consumers and the heartbeat schedule. BullMQ needs maxRetriesPerRequest = null. */
export async function startWorker({ redisUrl, heartbeatEveryMs = 60_000, log = () => {} }: WorkerOptions): Promise<WorkerRuntime> {
  const workerId = `${hostname()}:${process.pid}`;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const systemQueue = new Queue(QUEUES.system, { connection });
  const system = new Worker(QUEUES.system, systemProcessor(workerId), { connection, concurrency: 2 });

  system.on("completed", (job, result) => log("job completed", { queue: QUEUES.system, job: job.name, id: job.id, result }));
  system.on("failed", (job, err) => log("job failed", { queue: QUEUES.system, job: job?.name, id: job?.id, err: err.message }));

  await systemQueue.upsertJobScheduler("heartbeat", { every: heartbeatEveryMs }, { name: "heartbeat", opts: { removeOnComplete: 100, removeOnFail: 100 } });

  return {
    workerId,
    systemQueue,
    async stop() {
      await system.close();
      await systemQueue.close();
      connection.disconnect();
    },
  };
}
