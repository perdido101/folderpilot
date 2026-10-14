import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { QUEUES } from "@folderpilot/core";
import { startWorker, type WorkerRuntime } from "./worker";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
let runtime: WorkerRuntime | undefined;

afterAll(async () => {
  await runtime?.stop();
});

describe("worker (real Redis)", () => {
  it("consumes a heartbeat job enqueued on the system queue", async () => {
    runtime = await startWorker({ redisUrl: url, heartbeatEveryMs: 3_600_000 });
    const events = new QueueEvents(QUEUES.system, { connection: new Redis(url, { maxRetriesPerRequest: null }) });
    await events.waitUntilReady();
    const job = await runtime.systemQueue.add("heartbeat", {});
    const result = (await job.waitUntilFinished(events, 10_000)) as { workerId: string };
    expect(result.workerId).toBe(runtime.workerId);
    await events.close();
  }, 20_000);
});
