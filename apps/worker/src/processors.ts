import type { Job } from "bullmq";

/** Result of a heartbeat: proves the worker is consuming jobs (shown in health checks later). */
export interface HeartbeatResult {
  at: string;
  workerId: string;
  uptimeSec: number;
}

export async function heartbeat(workerId: string): Promise<HeartbeatResult> {
  return { at: new Date().toISOString(), workerId, uptimeSec: Math.round(process.uptime()) };
}

/**
 * Processor registry for the `system` queue. Phase 3+ adds indexing/analysis/ai/embeddings/rules/sync
 * queues with their own processors; unknown jobs fail loudly instead of being silently dropped.
 */
export function systemProcessor(workerId: string) {
  return async (job: Job) => {
    switch (job.name) {
      case "heartbeat":
        return heartbeat(workerId);
      default:
        throw new Error(`Unknown system job "${job.name}"`);
    }
  };
}
