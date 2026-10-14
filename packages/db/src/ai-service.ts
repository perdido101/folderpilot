/**
 * Metered AI analysis shared by the API (FolderPilot AI for "This device" folders) and the worker (server spaces):
 * monthly file budget → insight cache by content hash → provider call → usage record.
 */
import type { AIProvider, AnalyzeContext, FileInsight, FileMeta, InsightResult, Usage } from "@folderpilot/ai";
import { FileInsightSchema } from "@folderpilot/ai";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "./client";
import { aiInsightCache, aiUsage } from "./schema";

export class BudgetExceededError extends Error {
  constructor(readonly budget: number) {
    super(`Monthly AI budget reached (${budget} files). An admin can raise it in Settings → AI, or it resets on the 1st.`);
    this.name = "BudgetExceededError";
  }
}

export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export interface UsageSummary {
  files: number;
  inputTokens: number;
  outputTokens: number;
  since: string;
}

export async function usageThisMonth(db: Database, orgId: string, now = new Date()): Promise<UsageSummary> {
  const since = monthStart(now);
  const [row] = await db
    .select({
      files: sql<number>`coalesce(sum(${aiUsage.files}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, orgId), gte(aiUsage.at, since)));
  return { files: row?.files ?? 0, inputTokens: row?.inputTokens ?? 0, outputTokens: row?.outputTokens ?? 0, since: since.toISOString() };
}

export async function recordUsage(db: Database, orgId: string, entry: { provider: string; model: string; purpose: "analysis" | "agent" | "embedding"; usage: Usage; files: number }) {
  await db.insert(aiUsage).values({
    organizationId: orgId,
    provider: entry.provider,
    model: entry.model,
    purpose: entry.purpose,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    files: entry.files,
  });
}

export interface DescribeInput {
  kind: "image" | "text";
  image?: Blob;
  text?: string;
  meta: FileMeta;
  ctx: AnalyzeContext;
}

export interface MeteredInsight extends InsightResult {
  cached: boolean;
}

/** Describe one file within the organization's budget, reusing a cached insight for identical content. */
export async function describeMetered(db: Database, orgId: string, provider: AIProvider, input: DescribeInput, budget: number): Promise<MeteredInsight> {
  const sha = input.meta.sha256;
  if (sha) {
    const [hit] = await db
      .select()
      .from(aiInsightCache)
      .where(and(eq(aiInsightCache.organizationId, orgId), eq(aiInsightCache.sha256, sha), eq(aiInsightCache.cacheKey, provider.cacheKey)))
      .limit(1);
    const parsed = hit ? FileInsightSchema.safeParse(hit.insight) : null;
    if (hit && parsed?.success) return { insight: parsed.data, usage: { inputTokens: 0, outputTokens: 0 }, model: hit.model, cached: true };
  }
  const used = await usageThisMonth(db, orgId);
  if (used.files >= budget) throw new BudgetExceededError(budget);

  const result = input.kind === "image" && input.image ? await provider.describeImage(input.image, input.meta, input.ctx) : await provider.describeText(input.text ?? "", input.meta, input.ctx);
  await recordUsage(db, orgId, { provider: provider.cacheKey.split(":")[0]!, model: result.model, purpose: "analysis", usage: result.usage, files: 1 });
  if (sha) {
    await db
      .insert(aiInsightCache)
      .values({ organizationId: orgId, sha256: sha, cacheKey: provider.cacheKey, model: result.model, insight: result.insight as unknown as Record<string, unknown> })
      .onConflictDoNothing();
  }
  return { ...result, cached: false };
}

export type { FileInsight };
