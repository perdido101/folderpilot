/**
 * Search across an organization's spaces (spec §11): words (Postgres full-text) + meaning (pgvector), merged with
 * reciprocal-rank fusion, with filters and facet counts for the filter chips.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { loadOrgSettings, searchFiles, spaces, scoped } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireOrg, requirePermission } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { publicFile } from "./space-files";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SearchQuery = z.object({
  q: z.string().max(300).default(""),
  spaceId: z.string().uuid().optional(),
  kind: z.enum(["image", "document", "spreadsheet", "video", "audio", "archive", "code", "other"]).optional(),
  ext: z.string().max(10).optional(),
  category: z.string().max(60).optional(),
  flag: z.enum(["duplicate", "near_duplicate", "blurry", "dark", "tiny", "screenshot", "suggested_delete"]).optional(),
  client: z.string().max(80).optional(),
  from: date.optional(),
  to: date.optional(),
  /** "0" = words only (e.g. while typing in the palette). */
  semantic: z.enum(["0", "1"]).default("1"),
  facets: z.enum(["0", "1"]).default("0"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export function searchRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("/:orgId/*", requireOrg(deps));

  app.get("/:orgId/search", requirePermission("file", "view"), rateLimit(deps.redis, { prefix: "search", windowSec: 60, max: 240 }), async (c) => {
    const orgId = c.get("org").id;
    const parsed = SearchQuery.safeParse(c.req.query());
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Invalid search." });
    const p = parsed.data;
    const orgSpaces = await scoped(deps.db, orgId).select(spaces);
    if (p.spaceId && !orgSpaces.some((s) => s.id === p.spaceId)) throw new HTTPException(404, { message: "Space not found." });
    const names = new Map(orgSpaces.map((s) => [s.id, s.name]));
    const adapters = new Map(orgSpaces.map((s) => [s.id, s.adapterId]));
    const embedder = p.semantic === "1" ? deps.ai.embedderFor((await loadOrgSettings(deps.db, orgId, deps.encryptionKey)).ai) : null;
    const res = await searchFiles(deps.db, orgId, {
      q: p.q,
      filters: {
        ...(p.spaceId ? { spaceIds: [p.spaceId] } : {}),
        ...(p.kind ? { kind: p.kind } : {}),
        ...(p.ext ? { ext: p.ext.replace(/^\./, "").toLowerCase() } : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(p.flag ? { flag: p.flag } : {}),
        ...(p.client ? { client: p.client } : {}),
        ...(p.from ? { modifiedAfter: p.from } : {}),
        ...(p.to ? { modifiedBefore: p.to } : {}),
      },
      limit: p.limit,
      offset: p.offset,
      embedder,
      facets: p.facets === "1",
    });
    if (res.semanticError) deps.log.warn({ orgId, err: res.semanticError }, "search by meaning failed; words only");
    return c.json({
      results: res.hits.map((h) => ({ file: publicFile(h.file, adapters.get(h.file.spaceId)), spaceName: names.get(h.file.spaceId) ?? "", score: h.score, matchedBy: h.sources, snippet: h.snippet })),
      total: res.total,
      semantic: p.semantic === "0" ? "off" : res.semantic,
      chips: res.parsed.chips,
      ...(res.facets ? { facets: res.facets } : {}),
    });
  });

  return app;
}
