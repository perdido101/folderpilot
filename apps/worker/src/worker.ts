import { hostname } from "node:os";
import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, type AIJob, type AnalysisJob, type EmbeddingsJob, type FlagsJob, type IndexJob, type RulesJob } from "@folderpilot/core";
import { aiOne, analyzeOne, connectedSpacesToSync, indexSpace, PermanentJobError, recomputeSpaceFlags, type PipelineDeps } from "./pipeline/processors";
import { markNeedsReconnect, type Database } from "@folderpilot/db";
import { rulesForSpace, rulesTick } from "./pipeline/rules";
import { embedSpace } from "./pipeline/embeddings";
import { systemProcessor } from "./processors";

export interface WorkerRuntime {
  workerId: string;
  systemQueue: Queue;
  queues: { indexing: Queue; analysis: Queue; ai: Queue; rules: Queue; embeddings: Queue };
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
  /** How often scheduled rules are checked (default 15 minutes). */
  rulesTickEveryMs?: number;
  /** Debounce before a space's rules run after files change (default 2 s). */
  rulesDelayMs?: number;
  /** How often connected sources (Google Drive…) are checked for changes (default 5 minutes). */
  syncEveryMs?: number;
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

/** A provider stopped accepting our credentials: mark the space "needs reconnect" and don't retry. */
function guardAuth<T, R>(db: Database, fn: (data: T) => Promise<R>) {
  return async (data: T): Promise<R> => {
    try {
      return await fn(data);
    } catch (err) {
      if (err instanceof Error && err.name === "DriveAuthError" && data && typeof data === "object" && "spaceId" in data) {
        await markNeedsReconnect(db, String((data as { spaceId: string }).spaceId), err.message);
        throw new PermanentJobError(err.message);
      }
      throw err;
    }
  };
}

/** Start consumers and the heartbeat schedule. BullMQ needs maxRetriesPerRequest = null. */
export async function startWorker({ redisUrl, heartbeatEveryMs = 60_000, log = () => {}, pipeline, concurrency = {}, prefix, rulesTickEveryMs = 15 * 60_000, rulesDelayMs = 2000, syncEveryMs = 5 * 60_000 }: WorkerOptions): Promise<WorkerRuntime> {
  const workerId = `${hostname()}:${process.pid}`;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const base = { connection, ...(prefix ? { prefix } : {}) };
  const systemQueue = new Queue(QUEUES.system, base);
  const queues = {
    indexing: new Queue(QUEUES.indexing, base),
    analysis: new Queue(QUEUES.analysis, base),
    ai: new Queue(QUEUES.ai, base),
    rules: new Queue(QUEUES.rules, base),
    embeddings: new Queue(QUEUES.embeddings, base),
  };
  const workers: Worker[] = [new Worker(QUEUES.system, systemProcessor(workerId), { ...base, concurrency: 2 })];

  if (pipeline) {
    const enqueueRules = async (data: RulesJob) => {
      // One waiting rules job per space: a burst of analyzed files triggers one run.
      await queues.rules.add("space", data, { ...RETRY, jobId: `rules_${data.spaceId}`, delay: rulesDelayMs });
    };
    const enqueueEmbeddings = async (data: EmbeddingsJob) => {
      // One waiting embeddings job per space: a burst of analyzed files is embedded in batches.
      await queues.embeddings.add("space", data, { ...RETRY, jobId: `emb_${data.spaceId}`, delay: rulesDelayMs });
    };
    /** A file is ready for rules and for embedding. */
    const fileReady = async (orgId: string, spaceId: string) => {
      await enqueueRules({ orgId, spaceId });
      await enqueueEmbeddings({ orgId, spaceId });
    };
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
      new Worker<IndexJob | Record<string, never>>(
        QUEUES.indexing,
        permanent(
          guardAuth(pipeline.db, async (d: IndexJob | Record<string, never>) => {
            if (!("spaceId" in d)) {
              // Sync tick: check every connected space for changes (incremental, cheap when nothing changed).
              const due = await connectedSpacesToSync(pipeline.db);
              for (const s of due) await queues.indexing.add("index", { orgId: s.orgId, spaceId: s.spaceId, withAI: true } satisfies IndexJob, { ...RETRY, jobId: `sync_${s.spaceId}` });
              return { queued: due.length };
            }
            return indexSpace(deps, d as IndexJob);
          }),
        ),
        { ...base, concurrency: 1 },
      ),
      new Worker<AnalysisJob | FlagsJob>(
        QUEUES.analysis,
        async (job) => {
          try {
            if (job.name === "flags") return await recomputeSpaceFlags(deps, job.data as FlagsJob);
            return await guardAuth(pipeline.db, async (data: AnalysisJob) => {
              const result = await analyzeOne(deps, data);
              // Without AI the file is ready for rules now; otherwise rules run after its AI insight.
              if (!data.withAI) await fileReady(data.orgId, data.spaceId);
              return result;
            })(job.data as AnalysisJob);
          } catch (err) {
            if (err instanceof PermanentJobError) throw new UnrecoverableError(err.message);
            throw err;
          }
        },
        { ...base, concurrency: concurrency.analysis ?? 4 },
      ),
      new Worker<AIJob>(
        QUEUES.ai,
        permanent(guardAuth(pipeline.db, async (d: AIJob) => {
          try {
            return await aiOne(deps, d);
          } finally {
            // Rules run whether the AI answered, was skipped or failed for good (budget); a retry re-queues anyway.
            await fileReady(d.orgId, d.spaceId);
          }
        })),
        { ...base, concurrency: concurrency.ai ?? 2 },
      ),
      // One at a time so two runs never create the same pending plan.
      new Worker<RulesJob | Record<string, never>>(
        QUEUES.rules,
        permanent(async (d: RulesJob | Record<string, never>) => ("spaceId" in d ? rulesForSpace(deps, d as RulesJob) : rulesTick({ ...deps, enqueueRules, enqueueEmbeddings }))),
        { ...base, concurrency: 1 },
      ),
      new Worker<EmbeddingsJob>(
        QUEUES.embeddings,
        permanent((d: EmbeddingsJob) => embedSpace({ ...deps, requeue: (j) => queues.embeddings.add("space", j, { ...RETRY, jobId: `emb_${j.spaceId}_${Date.now()}` }).then(() => undefined) }, d)),
        { ...base, concurrency: 1 },
      ),
    );
    await queues.indexing.upsertJobScheduler("sync-tick", { every: syncEveryMs }, { name: "sync", data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } });
    await queues.rules.upsertJobScheduler("rules-tick", { every: rulesTickEveryMs }, { name: "tick", data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } });
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
