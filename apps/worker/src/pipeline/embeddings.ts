/**
 * Embeddings for search by meaning (spec §11). Per space: files whose embedded text or model changed get a new vector.
 * Without an embedding model (the org's AI can't embed and the server has no Ollama) this does nothing: search uses words.
 */
import { embedderFor, type EmbeddingFallback } from "@folderpilot/ai/server";
import { embedText, hashText, type EmbeddingsJob } from "@folderpilot/core";
import { files, loadOrgSettings, recordUsage, scoped } from "@folderpilot/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PipelineDeps } from "./processors";

const BATCH = 32;
/** Files per job; a bigger backlog re-queues itself. */
const PER_JOB = 512;

export async function embedSpace(deps: Pick<PipelineDeps, "db" | "encryptionKey"> & { embedFallback?: EmbeddingFallback; requeue?: (job: EmbeddingsJob) => Promise<void> }, job: EmbeddingsJob) {
  const { db } = deps;
  const settings = await loadOrgSettings(db, job.orgId, deps.encryptionKey);
  const embedder = embedderFor(settings.ai, deps.embedFallback ?? {});
  if (!embedder) return { skipped: "no embedding model" };

  const rows = await scoped(db, job.orgId).select(files, and(eq(files.spaceId, job.spaceId), sql`${files.status} <> 'trashed'`, sql`${files.analyzedAt} is not null`) as SQL);
  const todo = rows
    .map((f) => ({ f, text: embedText({ name: f.name, category: f.category, client: f.entities?.client, docType: f.entities?.docType, caption: f.caption, tags: f.tags, textExcerpt: f.textExcerpt }) }))
    .filter(({ f, text }) => f.embeddingModel !== embedder.model || f.embeddingHash !== hashText(text));
  const now = todo.slice(0, PER_JOB);
  for (let i = 0; i < now.length; i += BATCH) {
    const batch = now.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map((b) => b.text));
    for (const [j, b] of batch.entries()) {
      const v = vectors[j];
      if (!v) continue;
      await scoped(db, job.orgId).update(files, eq(files.id, b.f.id), { embedding: v, embeddingModel: embedder.model, embeddingHash: hashText(b.text) });
    }
  }
  if (now.length) await recordUsage(db, job.orgId, { provider: embedder.model.split(":")[0]!, model: embedder.model, purpose: "embedding", usage: { inputTokens: 0, outputTokens: 0 }, files: 0 });
  if (todo.length > now.length) await deps.requeue?.(job);
  return { embedded: now.length, remaining: todo.length - now.length, model: embedder.model };
}
