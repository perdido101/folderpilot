/** Ranking helpers shared by every search runtime. */

export interface Fused<Id> {
  id: Id;
  score: number;
  /** Which lists found it, e.g. ["words", "meaning"]. */
  sources: string[];
}

/**
 * Reciprocal-rank fusion (Cormack et al.): score = Σ 1 / (k + rank). Robust to the different score scales of
 * full-text and vector search; items found by both rise to the top.
 */
export function rrf<Id>(lists: { name: string; ids: Id[] }[], k = 60): Fused<Id>[] {
  const out = new Map<Id, Fused<Id>>();
  for (const list of lists) {
    list.ids.forEach((id, rank) => {
      const cur = out.get(id) ?? { id, score: 0, sources: [] };
      cur.score += 1 / (k + rank + 1);
      if (!cur.sources.includes(list.name)) cur.sources.push(list.name);
      out.set(id, cur);
    });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

/** Every stored vector has this many dimensions (files.embedding vector(1024)). */
export const EMBEDDING_DIMS = 1024;

export class EmbeddingSizeError extends Error {}

/**
 * Fit a vector to the stored size. Shorter vectors are zero-padded (cosine similarity is unchanged); longer ones are
 * refused — truncating would silently degrade search.
 */
export function toDims(v: number[], dims = EMBEDDING_DIMS): number[] {
  if (v.length === dims) return v;
  if (v.length > dims) throw new EmbeddingSizeError(`This embedding model makes ${v.length}-dimensional vectors; FolderPilot stores ${dims}. Pick a model with at most ${dims} dimensions (or one that supports reduced dimensions).`);
  return [...v, ...new Array<number>(dims - v.length).fill(0)];
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

/** What gets embedded for a file: what it is called and what it is about (no full text). */
export function embedText(f: { name: string; category?: string | null; client?: string | null; docType?: string | null; caption?: string | null; tags: string[]; textExcerpt?: string | null }): string {
  return [f.name, f.category, f.client, f.docType, f.caption, f.tags.join(", "), (f.textExcerpt ?? "").slice(0, 600)].filter(Boolean).join("\n");
}

/** Short stable hash (FNV-1a) so unchanged text is never embedded twice. */
export function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
