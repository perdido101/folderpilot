import { db, type FileRecord } from "../db";
import { getSettings } from "../settings";
import { makeAIThumbnail } from "../thumbnails";
import { matchesRule } from "../rules/evaluate";
import { useAnalysis } from "@/stores/analysis";
import { createProvider } from "./index";
import type { AnalyzeContext, FileMeta } from "./types";

const DEFAULT_CATEGORIES = ["Invoices", "Receipts", "Contracts", "NDAs", "Bank statements", "Photos", "Screenshots", "Scans", "Notes", "Spreadsheets", "Archives", "Manuals"];
const CONCURRENCY = 2;

export function fileMeta(f: FileRecord): FileMeta {
  return { name: f.name, path: f.path, ext: f.ext, size: f.size, mtime: f.mtime, width: f.width, height: f.height, exif: f.exif, flags: f.flags };
}

export async function analyzeContext(rootId: number): Promise<AnalyzeContext> {
  const files = await db.files.where("rootId").equals(rootId).toArray();
  const used = files.map((f) => f.category).filter((c): c is string => Boolean(c));
  const rules = await db.rules.toArray();
  return {
    knownCategories: [...new Set([...used, ...DEFAULT_CATEGORIES])].slice(0, 40),
    naturalRules: rules.filter((r) => r.enabled && r.type === "natural" && r.naturalText).map((r) => r.naturalText!),
  };
}

/**
 * AI analysis: category, tags, caption, suggested name and confidence for each file.
 * Order per CLAUDE.md: structured rules that set a category win → natural-language rules (in the prompt) → AI.
 * Results are stored in the index as suggestions; renaming/moving files on disk always goes through a plan.
 */
export async function runAIAnalysis(rootId: number, onlyIds?: number[]): Promise<{ analyzed: number; review: number; failed: number }> {
  const settings = await getSettings();
  const provider = createProvider(settings.ai);
  if (!provider) throw new Error("Connect an AI in Settings first.");
  const store = useAnalysis.getState();
  if (store.phase !== "idle") throw new Error("Analysis is already running.");

  const all = await db.files.where("rootId").equals(rootId).toArray();
  const todo = onlyIds
    ? all.filter((f) => onlyIds.includes(f.id) && f.status !== "trashed")
    : all.filter((f) => f.status === "indexed" && f.analyzedLocally);
  const ctx = await analyzeContext(rootId);
  const rules = (await db.rules.toArray()).filter((r) => r.enabled && r.type === "structured").sort((a, b) => a.priority - b.priority);

  store.set({ phase: "ai", done: 0, total: todo.length, lastError: null });
  let analyzed = 0;
  let review = 0;
  let failed = 0;
  let cursor = 0;

  const lane = async () => {
    while (cursor < todo.length) {
      const f = todo[cursor++]!;
      useAnalysis.getState().markInFlight(f.id, true);
      try {
        const thumb = f.kind === "image" ? await makeAIThumbnail(f) : null;
        const insight = thumb ? await provider.describeImage(thumb, fileMeta(f), ctx) : await provider.describeText(f.textExcerpt ?? "", fileMeta(f), ctx);
        const ruleCategory = rules.find((r) => matchesRule(f, r) && r.actions.some((a) => a.type === "set_category"))?.actions.find((a) => a.type === "set_category")?.value;
        const low = insight.confidence < settings.thresholds.confidence && !ruleCategory;
        await db.files.update(f.id, {
          category: ruleCategory || insight.category,
          categorySource: ruleCategory ? "rule" : "ai",
          tags: [...new Set([...f.tags, ...insight.tags])],
          caption: insight.caption,
          suggestedName: insight.suggestedName,
          client: insight.client ?? undefined,
          confidence: insight.confidence,
          aiReason: insight.reason,
          status: low ? "needs_review" : "analyzed",
        });
        if (!ctx.knownCategories.includes(insight.category)) ctx.knownCategories.push(insight.category);
        if (low) review++;
        else analyzed++;
      } catch (err) {
        failed++;
        useAnalysis.getState().set({ lastError: `${f.name}: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        const s = useAnalysis.getState();
        s.markInFlight(f.id, false);
        s.set({ done: s.done + 1 });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  } finally {
    useAnalysis.getState().set({ phase: "idle" });
  }
  return { analyzed, review, failed };
}
