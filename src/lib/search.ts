import { db, type FileRecord } from "./db";
import type { AIProvider } from "./ai/types";

const STOPWORDS = new Set(
  "the a an of to and or for in on with from by my our find show me all files file that this those these where is are was be please the το τα η ο οι με από απο του της των και για στο στη στα σε ένα μια βρες δείξε".split(" "),
);

/** Lowercase, strip accents (so "τιμολογιο" finds "Τιμολόγιο"). */
export function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

interface ParsedQuery {
  terms: string[];
  year?: number;
  kind?: FileRecord["kind"];
  ext?: string;
  flag?: string;
}

const KIND_WORDS: [RegExp, Partial<ParsedQuery>][] = [
  [/^(photos?|images?|pictures?|pics?|φωτογραφιες|φωτογραφια|εικονες|εικονα)$/, { kind: "image" }],
  [/^(screenshots?|στιγμιοτυπα|στιγμιοτυπο)$/, { flag: "screenshot" }],
  [/^(pdfs?)$/, { ext: "pdf" }],
  [/^(spreadsheets?|excel|csv)$/, { kind: "spreadsheet" }],
  [/^(videos?|βιντεο)$/, { kind: "video" }],
  [/^(word|docx?)$/, { ext: "docx" }],
];

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { terms: [] };
  for (const raw of norm(q).split(/[\s,;:!?"'()]+/)) {
    const w = raw.replace(/^[.#]+|[.]+$/g, "");
    if (!w || STOPWORDS.has(w)) continue;
    if (/^(19|20)\d\d$/.test(w)) {
      out.year = Number(w);
      continue;
    }
    const kind = KIND_WORDS.find(([re]) => re.test(w));
    if (kind) Object.assign(out, kind[1]);
    else out.terms.push(w.endsWith("s") && w.length > 4 ? w.slice(0, -1) : w); // "invoices" → "invoice"
  }
  return out;
}

const FIELDS: [keyof FileRecord, number][] = [
  ["name", 5],
  ["category", 3],
  ["client", 3],
  ["caption", 3],
  ["suggestedName", 2],
  ["path", 2],
  ["textExcerpt", 1],
];

/**
 * Keyword search over name, path, caption, tags, category, client and extracted text.
 * Every term must match somewhere; a year matches the modified date or appears in the text.
 */
export function keywordSearch(files: FileRecord[], query: string): { file: FileRecord; score: number }[] {
  const q = parseQuery(query);
  if (!q.terms.length && !q.year && !q.kind && !q.ext && !q.flag) return [];
  const results: { file: FileRecord; score: number }[] = [];
  for (const f of files) {
    if (f.status === "trashed") continue;
    if (q.kind && f.kind !== q.kind) continue;
    if (q.ext && f.ext !== q.ext) continue;
    if (q.flag && !f.flags.includes(q.flag as never) && !norm(f.name).includes("screenshot")) continue;
    const hay = FIELDS.map(([k, w]) => [norm(String(f[k] ?? "")), w] as const);
    const tags = norm(f.tags.join(" "));
    if (q.year && new Date(f.mtime).getFullYear() !== q.year && !hay.some(([h]) => h.includes(String(q.year)))) continue;
    let score = 1;
    let ok = true;
    for (const term of q.terms) {
      let best = 0;
      for (const [h, w] of hay) if (h.includes(term)) best = Math.max(best, w);
      if (tags.includes(term)) best = Math.max(best, 3);
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

export function embedText(f: FileRecord): string {
  return [f.name, f.category, f.client, f.caption, f.tags.join(", "), (f.textExcerpt ?? "").slice(0, 600)].filter(Boolean).join("\n");
}

function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

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

/** Semantic ranking by cosine similarity, blended with keyword matches. */
export async function semanticSearch(rootId: number, files: FileRecord[], query: string, provider: AIProvider): Promise<{ file: FileRecord; score: number }[]> {
  if (!provider.embed) return keywordSearch(files, query);
  const [qv] = await provider.embed([query]);
  if (!qv) return keywordSearch(files, query);
  const vectors = new Map((await db.embeddings.where("rootId").equals(rootId).toArray()).map((e) => [e.fileId, e.vector]));
  const keyword = new Map(keywordSearch(files, query).map((r) => [r.file.id, r.score]));
  const maxK = Math.max(1, ...keyword.values());
  return files
    .filter((f) => f.status !== "trashed")
    .map((f) => {
      const v = vectors.get(f.id);
      const sem = v ? cosine(qv, v) : 0;
      return { file: f, score: 0.7 * sem + 0.3 * ((keyword.get(f.id) ?? 0) / maxK) };
    })
    .filter((r) => r.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 200);
}
