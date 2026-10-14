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
