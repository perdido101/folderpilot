import { hostname } from "node:os";
import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, type AIJob, type AnalysisJob, type FlagsJob, type IndexJob } from "@folderpilot/core";
import { aiOne, analyzeOne, indexSpace, PermanentJobError, recomputeSpaceFlags, type PipelineDeps } from "./pipeline/processors";
import { systemProcessor } from "./processors";

export interface WorkerRuntime {
  workerId: string;
  systemQueue: Queue;
  queues: { indexing: Queue; analysis: Queue; ai: Queue };
  stop(): Promise<void>;
}

export interface WorkerOptions {
  redisUrl: string;
  heartbeatEveryMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Without it only the system queue runs (heartbeat). */
  pipeline?: Omit<PipelineDeps, "enqueueAnalysis" | "enqueueFlags" | "enqueueAI">;
  concurrency?: { analysis?: number; ai?: number };
  /** BullMQ key prefix (tests use their own so they never compete with a running dev worker). */
  prefix?: string;
}

const RETRY: JobsOptions = { attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: true, removeOnFail: 500 };

/** Turn "can't be fixed by retrying" errors into BullMQ's no-retry failure. */
const permanent =
  <T, R>(fn: (data: T) => Promise<R>) =>
  async (job: Job<T>) => {
    try {
      return await fn(job.data);
    } catch (err) {
      if (err instanceof PermanentJobError) throw new UnrecoverableError(err.message);
      throw err;
    }
  };

/** Start consumers and the heartbeat schedule. BullMQ needs maxRetriesPerRequest = null. */
export async function startWorker({ redisUrl, heartbeatEveryMs = 60_000, log = () => {}, pipeline, concurrency = {}, prefix }: WorkerOptions): Promise<WorkerRuntime> {
  const workerId = `${hostname()}:${process.pid}`;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const base = { connection, ...(prefix ? { prefix } : {}) };
  const systemQueue = new Queue(QUEUES.system, base);
  const queues = {
    indexing: new Queue(QUEUES.indexing, base),
    analysis: new Queue(QUEUES.analysis, base),
    ai: new Queue(QUEUES.ai, base),
  };
  const workers: Worker[] = [new Worker(QUEUES.system, systemProcessor(workerId), { ...base, concurrency: 2 })];

  if (pipeline) {
    const deps: PipelineDeps = {
      ...pipeline,
      async enqueueAnalysis(jobs: AnalysisJob[]) {
        await queues.analysis.addBulk(jobs.map((data) => ({ name: "analyze", data, opts: { ...RETRY, jobId: `an_${data.fileId}` } })));
      },
      async enqueueFlags(data: FlagsJob) {
        // One pending flags job per space: many analyses finishing close together trigger one recompute.
        await queues.analysis.add("flags", data, { ...RETRY, jobId: `flags_${data.spaceId}`, delay: 1500 });
      },
      async enqueueAI(jobs: AIJob[]) {
        await queues.ai.addBulk(jobs.map((data) => ({ name: "describe", data, opts: { ...RETRY, jobId: `ai_${data.fileId}` } })));
      },
    };
    workers.push(
      new Worker<IndexJob>(QUEUES.indexing, permanent((d: IndexJob) => indexSpace(deps, d)), { ...base, concurrency: 1 }),
      new Worker<AnalysisJob | FlagsJob>(
        QUEUES.analysis,
        async (job) => {
          try {
            return job.name === "flags" ? await recomputeSpaceFlags(deps, job.data as FlagsJob) : await analyzeOne(deps, job.data as AnalysisJob);
          } catch (err) {
            if (err instanceof PermanentJobError) throw new UnrecoverableError(err.message);
            throw err;
          }
        },
        { ...base, concurrency: concurrency.analysis ?? 4 },
      ),
      new Worker<AIJob>(QUEUES.ai, permanent((d: AIJob) => aiOne(deps, d)), { ...base, concurrency: concurrency.ai ?? 2 }),
    );
  }

  for (const w of workers) {
    w.on("completed", (job, result) => log("job completed", { queue: w.name, job: job.name, id: job.id, result }));
    w.on("failed", (job, err) => log("job failed", { queue: w.name, job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }));
  }

  await systemQueue.upsertJobScheduler("heartbeat", { every: heartbeatEveryMs }, { name: "heartbeat", opts: { removeOnComplete: 100, removeOnFail: 100 } });

  return {
    workerId,
    systemQueue,
    queues,
    async stop() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([systemQueue, ...Object.values(queues)].map((q) => q.close()));
      connection.disconnect();
    },
  };
}
