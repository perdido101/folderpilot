/**
 * Hybrid search (spec §11): Postgres full-text (weighted, accent-insensitive) + pgvector similarity, merged with
 * reciprocal-rank fusion. Shared by the search API, the agent's search_files and (phase 10) the MCP server.
 * Every query is scoped to one organization.
 */
import { and, desc, eq, gte, ilike, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Embedder } from "@folderpilot/ai";
import { extsOfKind, kindOf, KNOWN_EXTS, parseQuery, rrf, type FileKind, type ParsedQuery } from "@folderpilot/core";
import type { Database } from "./client";
import { files, spaces } from "./schema";

type FileRow = typeof files.$inferSelect;

export interface SearchFilters {
  spaceIds?: string[];
  folder?: string;
  kind?: string;
  ext?: string;
  category?: string;
  flag?: string;
  client?: string;
  status?: string;
  /** Modified on/after, YYYY-MM-DD. */
  modifiedAfter?: string;
  /** Modified before, YYYY-MM-DD. */
  modifiedBefore?: string;
}

const like = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

/** SQL conditions for the filters every search surface understands (trashed files are excluded unless asked for). */
export function fileFilterSql(f: SearchFilters): SQL[] {
  const out: SQL[] = [];
  out.push(f.status ? sql`${files.status} = ${f.status}` : sql`${files.status} <> 'trashed'`);
  if (f.spaceIds?.length) out.push(inArray(files.spaceId, f.spaceIds));
  if (f.folder) out.push(sql`(${files.path} ilike ${`${f.folder.replace(/[%_\\]/g, "\\$&")}/%`})`);
  if (f.category) out.push(ilike(files.category, f.category));
  if (f.ext) out.push(eq(files.ext, f.ext));
  if (f.flag) out.push(sql`${f.flag} = any(${files.flags})`);
  if (f.client) out.push(sql`(${files.entities}->>'client') ilike ${like(f.client)}`);
  if (f.kind) {
    const exts = extsOfKind(f.kind as FileKind);
    out.push(exts.length ? inArray(files.ext, [...exts]) : sql`not (${files.ext} = any(${KNOWN_EXTS as string[]}))`);
  }
  if (f.modifiedAfter && !Number.isNaN(Date.parse(f.modifiedAfter))) out.push(gte(files.mtime, new Date(f.modifiedAfter)));
  if (f.modifiedBefore && !Number.isNaN(Date.parse(f.modifiedBefore))) out.push(lt(files.mtime, new Date(f.modifiedBefore)));
  return out;
}

/** Words → a prefix tsquery ("alpha invoic" → 'alpha:* & invoic:*'); null when nothing searchable is left. */
export function toTsQuery(terms: string[]): string | null {
  const pieces = terms.flatMap((t) => t.split(/[^\p{L}\p{N}]+/u)).filter((p) => p.length > 0);
  return pieces.length ? pieces.map((p) => `${p}:*`).join(" & ") : null;
}

// Query embeddings are cached briefly: typing the same query again (or paging) costs nothing.
const QUERY_CACHE = new Map<string, { at: number; vector: number[] }>();
const QUERY_TTL_MS = 10 * 60_000;
async function queryVector(embedder: Embedder, text: string): Promise<number[]> {
  const key = `${embedder.model}|${text}`;
  const hit = QUERY_CACHE.get(key);
  if (hit && Date.now() - hit.at < QUERY_TTL_MS) return hit.vector;
  const [vector] = await embedder.embed([text]);
  if (!vector) throw new Error("The embedding model returned nothing.");
  if (QUERY_CACHE.size > 500) QUERY_CACHE.delete(QUERY_CACHE.keys().next().value!);
  QUERY_CACHE.set(key, { at: Date.now(), vector });
  return vector;
}

export interface SearchOptions {
  q: string;
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
  /** null/undefined = search by words only. */
  embedder?: Embedder | null;
  /** Lowest cosine similarity a meaning-only match needs. */
  minSimilarity?: number;
  /** Also count results per category/kind/space/client (for filter chips). */
  facets?: boolean;
  now?: Date;
}

export interface SearchHit {
  file: FileRow;
  score: number;
  /** "words", "meaning" or both. */
  sources: string[];
  /** Matching words wrapped in [[ ]] (from the caption or text). */
  snippet: string | null;
}

export interface SearchFacets {
  category: { key: string; count: number }[];
  kind: { key: string; count: number }[];
  space: { key: string; name: string; count: number }[];
  client: { key: string; count: number }[];
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  /** on = meaning was used; unavailable = no embedding model is set up (words only). */
  semantic: "on" | "unavailable" | "error";
  semanticError?: string;
  parsed: ParsedQuery;
  facets?: SearchFacets;
}

const CANDIDATES = 200;

export async function searchFiles(db: Database, orgId: string, opts: SearchOptions): Promise<SearchResult> {
  const parsed = parseQuery(opts.q, opts.now);
  const filters: SearchFilters = {
    ...(parsed.kind ? { kind: parsed.kind } : {}),
    ...(parsed.ext ? { ext: parsed.ext } : {}),
    ...(parsed.flag ? { flag: parsed.flag } : {}),
    ...(parsed.from ? { modifiedAfter: parsed.from } : {}),
    ...(parsed.to ? { modifiedBefore: parsed.to } : {}),
    ...opts.filters,
  };
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const base = and(eq(files.organizationId, orgId), ...fileFilterSql(filters)) as SQL;
  const tsq = toTsQuery(parsed.terms);
  let semantic: SearchResult["semantic"] = opts.embedder ? "on" : "unavailable";
  let semanticError: string | undefined;

  // No words: just the filtered files, newest first.
  if (!parsed.terms.length) {
    const rows = await db.select().from(files).where(base).orderBy(desc(files.mtime), files.id).limit(limit).offset(offset);
    const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(files).where(base);
    const result: SearchResult = { hits: rows.map((file) => ({ file, score: 0, sources: [], snippet: null })), total: total?.n ?? 0, semantic, parsed };
    if (opts.facets) result.facets = await facetsFor(db, orgId, base);
    return result;
  }

  const words = tsq
    ? await db
        .select({ id: files.id })
        .from(files)
        .where(and(base, sql`${files.searchTsv} @@ to_tsquery('simple', unaccent(${tsq}))`))
        .orderBy(desc(sql`ts_rank_cd(${files.searchTsv}, to_tsquery('simple', unaccent(${tsq})), 32)`), desc(files.mtime))
        .limit(CANDIDATES)
    : [];

  let meaning: { id: string }[] = [];
  if (opts.embedder) {
    try {
      const vector = await queryVector(opts.embedder, parsed.terms.join(" "));
      const literal = `[${vector.join(",")}]`;
      const minSim = opts.minSimilarity ?? 0.3;
      meaning = await db.transaction(async (tx) => {
        // Filters are applied while walking the HNSW graph, so keep scanning until enough rows pass them.
        await tx.execute(sql`set local hnsw.ef_search = 200`);
        await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
        const rows = await tx
          .select({ id: files.id, sim: sql<number>`1 - (${files.embedding} <=> ${literal}::vector)` })
          .from(files)
          .where(and(base, eq(files.embeddingModel, opts.embedder!.model), sql`${files.embedding} is not null`))
          .orderBy(sql`${files.embedding} <=> ${literal}::vector`)
          .limit(CANDIDATES);
        return rows.filter((r) => Number(r.sim) >= minSim);
      });
    } catch (err) {
      semantic = "error";
      semanticError = err instanceof Error ? err.message : String(err);
    }
  }

  const fused = rrf([
    { name: "words", ids: words.map((w) => w.id) },
    { name: "meaning", ids: meaning.map((m) => m.id) },
  ]);
  const page = fused.slice(offset, offset + limit);
  const rows = page.length
    ? await db
        .select({
          file: files,
          snippet: tsq
            ? sql<string | null>`case when ${files.searchTsv} @@ to_tsquery('simple', unaccent(${tsq})) then nullif(ts_headline('simple', unaccent(concat_ws(' — ', ${files.caption}, left(${files.textExcerpt}, 3000))), to_tsquery('simple', unaccent(${tsq})), 'StartSel=[[,StopSel=]],MaxWords=22,MinWords=8,MaxFragments=1'), '') end`
            : sql<null>`null`,
        })
        .from(files)
        .where(and(eq(files.organizationId, orgId), inArray(files.id, page.map((p) => p.id))))
    : [];
  const byId = new Map(rows.map((r) => [r.file.id, r]));
  const hits = page.flatMap((p) => {
    const r = byId.get(p.id);
    // A snippet is only useful when it shows a match.
    return r ? [{ file: r.file, score: p.score, sources: p.sources, snippet: r.snippet && r.snippet.includes("[[") ? r.snippet : null }] : [];
  });
  const result: SearchResult = { hits, total: fused.length, semantic, parsed, ...(semanticError ? { semanticError } : {}) };
  if (opts.facets) result.facets = fused.length ? await facetsFor(db, orgId, and(eq(files.organizationId, orgId), inArray(files.id, fused.map((f) => f.id))) as SQL) : emptyFacets();
  return result;
}

const emptyFacets = (): SearchFacets => ({ category: [], kind: [], space: [], client: [] });

async function facetsFor(db: Database, orgId: string, where: SQL): Promise<SearchFacets> {
  const count = sql<number>`count(*)::int`;
  const [cats, exts, sps, clients] = await Promise.all([
    db.select({ key: sql<string>`coalesce(${files.category}, 'Uncategorized')`, n: count }).from(files).where(where).groupBy(sql`1`),
    db.select({ key: files.ext, n: count }).from(files).where(where).groupBy(files.ext),
    db.select({ key: files.spaceId, name: spaces.name, n: count }).from(files).innerJoin(spaces, and(eq(spaces.id, files.spaceId), eq(spaces.organizationId, orgId))).where(where).groupBy(files.spaceId, spaces.name),
    db.select({ key: sql<string>`${files.entities}->>'client'`, n: count }).from(files).where(and(where, sql`${files.entities}->>'client' is not null`)).groupBy(sql`1`),
  ]);
  const kinds = new Map<string, number>();
  for (const e of exts) kinds.set(kindOf(e.key), (kinds.get(kindOf(e.key)) ?? 0) + e.n);
  const sort = <T extends { count: number; key: string }>(l: T[]) => l.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 30);
  return {
    category: sort(cats.map((c) => ({ key: c.key, count: c.n }))),
    kind: sort([...kinds].map(([key, n]) => ({ key, count: n }))),
    space: sps.map((s) => ({ key: s.key, name: s.name, count: s.n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    client: sort(clients.map((c) => ({ key: c.key, count: c.n }))),
  };
}
