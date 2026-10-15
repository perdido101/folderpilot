/**
 * Search for folders on this device (spec §11): words (weighted fields) + meaning (embeddings, when the device AI can
 * embed), merged with reciprocal-rank fusion — the same parser and fusion as the server.
 */
import { db, type FileRecord } from "./db";
import { getSettings } from "./settings";
import type { AIProvider } from "@folderpilot/ai";
import { cosine, embedText as sharedEmbedText, hashText, norm, parseQuery, rrf, type ParsedQuery } from "@folderpilot/core";

export { cosine, norm, parseQuery };

const FIELDS: [keyof FileRecord, number][] = [
  ["name", 5],
  ["client", 4],
  ["category", 3],
  ["caption", 3],
  ["docType", 3],
  ["suggestedName", 2],
  ["path", 2],
  ["textExcerpt", 1],
];

/** Filters a parsed query implies (kind/extension/flag words, years, relative dates). */
export function matchesParsed(f: FileRecord, q: ParsedQuery): boolean {
  if (f.status === "trashed") return false;
  if (q.kind && f.kind !== q.kind) return false;
  if (q.ext && f.ext !== q.ext) return false;
  if (q.flag && !f.flags.includes(q.flag as never)) return false;
  if (q.from && f.mtime < Date.parse(q.from)) return false;
  if (q.to && f.mtime >= Date.parse(q.to)) return false;
  return true;
}

/** "invoices" also matches "invoice". */
const variants = (term: string) => (term.length > 4 && term.endsWith("s") ? [term, term.slice(0, -1)] : [term]);

/**
 * Keyword search: every word must match somewhere (name counts most, then client, category, caption…).
 * A query of only filter words ("screenshots 2026") lists the matching files, newest first.
 */
export function keywordSearch(files: FileRecord[], query: string, now = new Date()): { file: FileRecord; score: number }[] {
  const q = parseQuery(query, now);
  if (!q.terms.length && !q.chips.length) return [];
  const results: { file: FileRecord; score: number }[] = [];
  for (const f of files) {
    if (!matchesParsed(f, q)) continue;
    const hay = FIELDS.map(([k, w]) => [norm(String(f[k] ?? "")), w] as const);
    const tags = norm(f.tags.join(" "));
    let score = 1;
    let ok = true;
    for (const term of q.terms) {
      let best = 0;
      for (const v of variants(term)) {
        for (const [h, w] of hay) if (h.includes(v)) best = Math.max(best, w);
        if (tags.includes(v)) best = Math.max(best, 3);
      }
      if (!best) {
        ok = false;
        break;
      }
      score += best;
    }
    if (ok) results.push({ file: f, score });
  }
  return results.sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime);
}

export const embedText = (f: FileRecord) => sharedEmbedText({ name: f.name, category: f.category, client: f.client, docType: f.docType, caption: f.caption, tags: f.tags, textExcerpt: f.textExcerpt });

/** Embed every file whose text changed since its last vector. Returns how many were (re)embedded. */
export async function buildEmbeddings(rootId: number, provider: AIProvider, model: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  if (!provider.embed) throw new Error("This AI provider doesn't support embeddings; keyword search is used instead.");
  const files = (await db.files.where("rootId").equals(rootId).toArray()).filter((f) => f.status !== "trashed");
  const existing = new Map((await db.embeddings.where("rootId").equals(rootId).toArray()).map((e) => [e.fileId, e]));
  const todo = files.map((f) => ({ f, text: embedText(f) })).filter(({ f, text }) => {
    const e = existing.get(f.id);
    return !e || e.model !== model || e.textHash !== hashText(text);
  });
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const vectors = await provider.embed(batch.map((b) => b.text));
    await db.embeddings.bulkPut(batch.map((b, j) => ({ fileId: b.f.id, rootId, model, textHash: hashText(b.text), vector: vectors[j] ?? [] })));
    onProgress?.(Math.min(i + 32, todo.length), todo.length);
  }
  return todo.length;
}

export interface DeviceHit {
  file: FileRecord;
  score: number;
  /** "words", "meaning" or both. */
  sources: string[];
}

export interface DeviceSearch {
  hits: DeviceHit[];
  parsed: ParsedQuery;
  semantic: "on" | "unavailable" | "error";
}

/**
 * Hybrid search over a folder: words + meaning (when the provider can embed and the folder has an index for `model`),
 * merged with reciprocal-rank fusion.
 */
export async function hybridSearch(rootId: number, files: FileRecord[], query: string, opts: { provider?: AIProvider | null; model?: string; minSimilarity?: number; now?: Date } = {}): Promise<DeviceSearch> {
  const parsed = parseQuery(query, opts.now);
  const words = keywordSearch(files, query, opts.now);
  const provider = opts.provider;
  if (!parsed.terms.length || !provider?.embed) return { hits: words.map((w) => ({ ...w, sources: parsed.terms.length ? ["words"] : [] })), parsed, semantic: provider?.embed ? "on" : "unavailable" };
  let meaning: FileRecord[] = [];
  let semantic: DeviceSearch["semantic"] = "on";
  try {
    const stored = await db.embeddings.where("rootId").equals(rootId).toArray();
    const vectors = new Map(stored.filter((e) => !opts.model || e.model === opts.model).map((e) => [e.fileId, e.vector]));
    if (vectors.size) {
      const [qv] = await provider.embed([parsed.terms.join(" ")]);
      if (qv) {
        const min = opts.minSimilarity ?? 0.3;
        meaning = files
          .filter((f) => matchesParsed(f, parsed) && vectors.has(f.id))
          .map((f) => ({ f, sim: cosine(qv, vectors.get(f.id)!) }))
          .filter((x) => x.sim >= min)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 200)
          .map((x) => x.f);
      }
    }
  } catch {
    semantic = "error";
  }
  const byId = new Map(files.map((f) => [f.id, f]));
  const fused = rrf([
    { name: "words", ids: words.slice(0, 200).map((w) => w.file.id) },
    { name: "meaning", ids: meaning.map((f) => f.id) },
  ]);
  return { hits: fused.map((x) => ({ file: byId.get(x.id)!, score: x.score, sources: x.sources })), parsed, semantic };
}

/** The embedding model this device's AI uses (vectors from other models aren't compared). */
export async function deviceEmbedModel(): Promise<string | undefined> {
  const { ai } = await getSettings();
  return ai.provider === "ollama" ? ai.ollama.embedModel : ai.provider === "openai" ? ai.openai.embedModel : undefined;
}

/**
 * Keep the folder's index for search by meaning up to date (after AI analysis). Quietly does nothing when the device
 * AI can't embed; returns how many files were embedded.
 */
export async function refreshEmbeddings(rootId: number, provider: AIProvider | null): Promise<number> {
  const model = await deviceEmbedModel();
  if (!provider?.embed || !model) return 0;
  return buildEmbeddings(rootId, provider, model);
}

/** @deprecated kept for callers that only need files: hybrid search, files in rank order. */
export async function semanticSearch(rootId: number, files: FileRecord[], query: string, provider: AIProvider): Promise<{ file: FileRecord; score: number }[]> {
  return (await hybridSearch(rootId, files, query, { provider })).hits;
}
