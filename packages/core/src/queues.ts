/** BullMQ queue names shared by the server (producer) and worker (consumer). */
export const QUEUES = {
  system: "system",
  indexing: "indexing",
  analysis: "analysis",
  ai: "ai",
  embeddings: "embeddings",
  rules: "rules",
  sync: "sync",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Scan a space and bring the index up to date, then queue analysis of new/changed files. */
export interface IndexJob {
  orgId: string;
  spaceId: string;
  /** Also run AI on files that don't have an insight yet (when the org has AI configured). */
  withAI: boolean;
}

/** Local analysis of one file (hash, image metrics, EXIF, text). */
export interface AnalysisJob {
  orgId: string;
  spaceId: string;
  fileId: string;
  withAI: boolean;
}

/** Recompute duplicate/quality flags for a whole space (deduplicated per space). */
export interface FlagsJob {
  orgId: string;
  spaceId: string;
}

/** AI insight for one file (category, tags, caption, suggested name, entities, confidence). */
export interface AIJob {
  orgId: string;
  spaceId: string;
  fileId: string;
}

/** Run structured rules on new/changed files of a space (deduplicated per space). */
export interface RulesJob {
  orgId: string;
  spaceId: string;
}
