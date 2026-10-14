/**
 * The server-side analysis pipeline (spec §12, §5):
 *   index (scan the space) → analysis (per file, no AI) → flags (per space) → ai (per file, metered).
 * Every step is idempotent: a file whose current version was already analyzed is skipped.
 */
import { createServerProvider, type HostedAIConfig } from "@folderpilot/ai/server";
import type { AIProvider, AnalyzeContext, FileMeta } from "@folderpilot/ai";
import { analyzeFile, computeFlags } from "@folderpilot/analysis";
import { extOf, kindOf, matchesRule, type AIJob, type AnalysisJob, type FileFlag, type FlagsJob, type IndexJob, type StorageAdapter } from "@folderpilot/core";
import { BudgetExceededError, describeMetered, files, loadOrgSettings, rules, scoped, spaces, toEngineFile, toRule, type Database } from "@folderpilot/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { aiThumbnail, nodeAnalyzeDeps } from "./node-analysis";

export interface PipelineDeps {
  db: Database;
  encryptionKey: Buffer;
  hosted: HostedAIConfig;
  adapterFor(space: typeof spaces.$inferSelect): StorageAdapter;
  enqueueAnalysis(jobs: AnalysisJob[]): Promise<void>;
  enqueueFlags(job: FlagsJob): Promise<void>;
  enqueueAI(jobs: AIJob[]): Promise<void>;
}

/** Thrown for problems retrying can't fix (budget reached, AI not configured); the job fails without retries. */
export class PermanentJobError extends Error {}

const DEFAULT_CATEGORIES = ["Invoices", "Receipts", "Contracts", "NDAs", "Bank statements", "Photos", "Screenshots", "Scans", "Notes", "Spreadsheets", "Archives", "Manuals"];
/** Files above this are hashed but not decoded or read for text on the server. */
const MAX_ANALYZE_BYTES = 256 * 1024 * 1024;

async function loadSpace(db: Database, orgId: string, spaceId: string) {
  const space = await scoped(db, orgId).first(spaces, eq(spaces.id, spaceId));
  if (!space) throw new PermanentJobError(`Space ${spaceId} not found.`);
  return space;
}

async function loadFile(db: Database, orgId: string, fileId: string) {
  return scoped(db, orgId).first(files, eq(files.id, fileId));
}

async function readBlob(adapter: StorageAdapter, ref: { id: string }): Promise<Blob> {
  return new Response(await adapter.download(ref)).blob();
}

/** Scan the space and bring `files` up to date. Returns counts. */
export async function indexSpace(deps: PipelineDeps, job: IndexJob) {
  const { db } = deps;
  const space = await loadSpace(db, job.orgId, job.spaceId);
  const adapter = deps.adapterFor(space);
  const s = scoped(db, job.orgId);
  const existing = new Map((await s.select(files, eq(files.spaceId, space.id))).map((f) => [f.providerRef, f]));
  const seen = new Set<string>();
  let added = 0;
  let changed = 0;

  const { entries } = await adapter.changes();
  for (const ev of entries) {
    if (ev.type !== "upsert" || ev.entry.isFolder) continue;
    const e = ev.entry;
    seen.add(e.ref.id);
    const prev = existing.get(e.ref.id);
    const ext = extOf(e.name);
    if (!prev) {
      await s.insert(files, { spaceId: space.id, providerRef: e.ref.id, path: e.path, name: e.name, ext, size: e.size, mtime: new Date(e.mtime), version: e.version, ...(e.mime ? { mime: e.mime } : {}) });
      added++;
    } else if (prev.version !== e.version || prev.path !== e.path) {
      const contentChanged = prev.version !== e.version;
      await s.update(files, eq(files.id, prev.id), {
        path: e.path,
        name: e.name,
        ext,
        size: e.size,
        mtime: new Date(e.mtime),
        version: e.version,
        updatedAt: new Date(),
        // New content: analysis and AI must run again.
        ...(contentChanged ? { analyzedAt: null, aiAnalyzedAt: null, sha256: null, dhash: null, blurScore: null, brightness: null, width: null, height: null, exif: null, textExcerpt: null, status: prev.status === "trashed" ? "trashed" : "indexed" } : {}),
      });
      changed++;
    }
  }
  const gone = [...existing.values()].filter((f) => !seen.has(f.providerRef) && f.status !== "trashed").map((f) => f.id);
  // The index forgets files that are no longer there (the files themselves were removed outside FolderPilot).
  if (gone.length) await db.delete(files).where(s.where(files, inArray(files.id, gone)));
  await s.update(spaces, eq(spaces.id, space.id), { syncCursor: String(Date.now()), updatedAt: new Date() });

  const todo = await s.select(files, and(eq(files.spaceId, space.id), isNull(files.analyzedAt)));
  await deps.enqueueAnalysis(todo.map((f) => ({ orgId: job.orgId, spaceId: space.id, fileId: f.id, withAI: job.withAI })));
  if (job.withAI) {
    // Files analyzed earlier but never sent to the AI.
    const aiTodo = await s.select(files, and(eq(files.spaceId, space.id), isNull(files.aiAnalyzedAt), sql`${files.analyzedAt} is not null`));
    await deps.enqueueAI(aiTodo.map((f) => ({ orgId: job.orgId, spaceId: space.id, fileId: f.id })));
  }
  return { added, changed, removed: gone.length, queued: todo.length };
}

/** Hash, image metrics, EXIF and text for one file. */
export async function analyzeOne(deps: PipelineDeps, job: AnalysisJob) {
  const { db } = deps;
  const file = await loadFile(db, job.orgId, job.fileId);
  if (!file || file.status === "trashed") return { skipped: "gone" };
  if (file.analyzedAt) return { skipped: "already analyzed" };
  const space = await loadSpace(db, job.orgId, job.spaceId);
  const adapter = deps.adapterFor(space);
  const entry = await adapter.stat({ id: file.providerRef });
  if (entry.version !== file.version) return { skipped: "changed since indexing (the next scan picks it up)" };

  const kind = kindOf(file.ext);
  const data = entry.size > MAX_ANALYZE_BYTES ? null : await readBlob(adapter, { id: file.providerRef });
  const result = data ? await analyzeFile({ data, ext: file.ext, kind }, nodeAnalyzeDeps) : { warnings: ["too large to analyze on the server"] };
  const r = result as Awaited<ReturnType<typeof analyzeFile>>;
  await scoped(db, job.orgId).update(files, eq(files.id, file.id), {
    sha256: r.sha256 ?? null,
    dhash: r.dhash ?? null,
    blurScore: r.blurScore ?? null,
    brightness: r.brightness ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    exif: r.exif ?? null,
    textExcerpt: r.textExcerpt ?? null,
    analyzedAt: new Date(),
    updatedAt: new Date(),
  });
  await deps.enqueueFlags({ orgId: job.orgId, spaceId: job.spaceId });
  if (job.withAI) await deps.enqueueAI([{ orgId: job.orgId, spaceId: job.spaceId, fileId: file.id }]);
  return { analyzed: true, warnings: result.warnings };
}

/** Recompute duplicate/quality flags across the space (needs every file, so it runs per space). */
export async function recomputeSpaceFlags(deps: PipelineDeps, job: FlagsJob) {
  const { db } = deps;
  const settings = await loadOrgSettings(db, job.orgId, deps.encryptionKey);
  const s = scoped(db, job.orgId);
  const rows = await s.select(files, eq(files.spaceId, job.spaceId));
  const indexed = rows.map(toEngineFile);
  const next = computeFlags(indexed, settings.thresholds);
  let updated = 0;
  for (const f of indexed) {
    const flags = next.get(f.id);
    if (flags && flags.join() !== f.flags.join()) {
      await s.update(files, eq(files.id, String(f.id)), { flags: flags as FileFlag[], updatedAt: new Date() });
      updated++;
    }
  }
  return { files: rows.length, updated };
}

/** Categories in use + the org's natural-language rules, so the AI stays consistent. */
async function analyzeContext(db: Database, orgId: string): Promise<AnalyzeContext> {
  const used = await db
    .selectDistinct({ category: files.category })
    .from(files)
    .where(and(eq(files.organizationId, orgId), sql`${files.category} is not null`))
    .limit(60);
  const natural = await scoped(db, orgId).select(rules, and(eq(rules.enabled, true), eq(rules.type, "natural")));
  return {
    knownCategories: [...new Set([...used.map((u) => u.category!).filter(Boolean), ...DEFAULT_CATEGORIES])].slice(0, 40),
    naturalRules: natural.flatMap((r) => (r.naturalText ? [r.naturalText] : [])),
  };
}

/** The organization's configured AI (null = not configured: AI steps are skipped, not failed). */
export async function orgProvider(deps: PipelineDeps, orgId: string): Promise<{ provider: AIProvider | null; budget: number; confidence: number }> {
  const settings = await loadOrgSettings(deps.db, orgId, deps.encryptionKey);
  return { provider: createServerProvider(settings.ai, deps.hosted), budget: settings.aiMonthlyFileBudget, confidence: settings.thresholds.confidence };
}

/**
 * AI insight for one file. Order (spec §8): a structured rule that sets the category wins → natural-language rules
 * (in the prompt) → AI. Low confidence goes to Needs Review instead of guessing.
 */
export async function aiOne(deps: PipelineDeps, job: AIJob) {
  const { db } = deps;
  const file = await loadFile(db, job.orgId, job.fileId);
  if (!file || file.status === "trashed") return { skipped: "gone" };
  if (file.aiAnalyzedAt) return { skipped: "already analyzed" };
  if (!file.analyzedAt) return { skipped: "local analysis not done yet" };
  const { provider, budget, confidence } = await orgProvider(deps, job.orgId);
  if (!provider) return { skipped: "AI not configured" };

  const space = await loadSpace(db, job.orgId, job.spaceId);
  const adapter = deps.adapterFor(space);
  const indexed = toEngineFile(file);
  const meta: FileMeta = {
    name: file.name,
    path: file.path,
    ext: file.ext,
    size: file.size,
    mtime: file.mtime?.getTime() ?? 0,
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
    ...(file.exif ? { exif: file.exif } : {}),
    flags: file.flags,
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
  };
  const ctx = await analyzeContext(db, job.orgId);
  const thumb = indexed.kind === "image" && file.size <= MAX_ANALYZE_BYTES ? await aiThumbnail(await readBlob(adapter, { id: file.providerRef })) : null;

  let result;
  try {
    result = await describeMetered(db, job.orgId, provider, thumb ? { kind: "image", image: thumb, meta, ctx } : { kind: "text", text: file.textExcerpt ?? "", meta, ctx }, budget);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw new PermanentJobError(err.message);
    throw err;
  }
  const { insight } = result;

  const structured = (await scoped(db, job.orgId).select(rules, and(eq(rules.enabled, true), eq(rules.type, "structured")))).map(toRule).sort((a, b) => a.priority - b.priority);
  const ruleCategory = structured
    .find((r) => matchesRule(indexed, r) && r.actions.some((a) => a.type === "set_category"))
    ?.actions.find((a) => a.type === "set_category")?.value;
  const low = insight.confidence < confidence && !ruleCategory;

  await scoped(db, job.orgId).update(files, eq(files.id, file.id), {
    category: ruleCategory || insight.category,
    categorySource: ruleCategory ? "rule" : "ai",
    tags: [...new Set([...file.tags, ...insight.tags])],
    caption: insight.caption,
    suggestedName: insight.suggestedName || null,
    entities: Object.fromEntries(Object.entries(insight.entities).filter(([, v]) => v !== null)),
    confidence: insight.confidence,
    aiReason: insight.reason,
    status: file.status === "organized" ? "organized" : low ? "needs_review" : "analyzed",
    aiAnalyzedAt: new Date(),
    updatedAt: new Date(),
  });
  return { category: ruleCategory || insight.category, needsReview: low, cached: result.cached };
}
