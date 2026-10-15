/**
 * Files of a server space: listing with filters, Needs Review, Duplicates & Bad Files, scan/analyze, and review actions.
 * Review actions are plans executed through the core engine (Postgres store): audited and undoable.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, asc, count, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { exactGroups, nearGroups } from "@folderpilot/analysis";
import { can, createEngine, EngineError, type Approver, type FileFlag, type IndexJob, type PlanInput } from "@folderpilot/core";
import { createPgEngineStore, files, loadOrgSettings, scoped, spaces, toEngineFile } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireOrg, requirePermission } from "../middleware/auth";

type FileRow = typeof files.$inferSelect;

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json",
  log: "text/plain; charset=utf-8", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
};
/** Content type for previews; anything active (HTML, SVG, scripts) is served as an opaque download. */
export const contentTypeOf = (ext: string) => CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";

/** What the browser needs about a file (no provider internals). */
export function publicFile(f: FileRow) {
  return {
    id: f.id,
    spaceId: f.spaceId,
    path: f.path,
    name: f.name,
    ext: f.ext,
    size: f.size,
    mtime: f.mtime?.getTime() ?? 0,
    status: f.status,
    flags: f.flags,
    tags: f.tags,
    category: f.category,
    categorySource: f.categorySource,
    caption: f.caption,
    suggestedName: f.suggestedName,
    entities: f.entities,
    confidence: f.confidence,
    aiReason: f.aiReason,
    width: f.width,
    height: f.height,
    blurScore: f.blurScore,
    brightness: f.brightness,
    sha256: f.sha256,
    analyzed: f.analyzedAt !== null,
    aiAnalyzed: f.aiAnalyzedAt !== null,
    flagReason: f.flagReason,
  };
}

const ListQuery = z.object({
  status: z.enum(["indexed", "analyzed", "needs_review", "organized", "trashed"]).optional(),
  flag: z.enum(["duplicate", "near_duplicate", "blurry", "dark", "tiny", "screenshot", "suggested_delete"]).optional(),
  category: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  /** Comma-separated file ids (e.g. the files an agent answer mentions). Includes trashed files. */
  ids: z
    .string()
    .max(40 * 100)
    .optional()
    .transform((v) => (v ? v.split(",").filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100) : undefined)),
});

const ReviewBody = z.discriminatedUnion("action", [
  /** Accept the AI's suggestion as is (Needs Review → analyzed). */
  z.object({ action: z.literal("accept"), fileIds: z.array(z.string().uuid()).min(1).max(500) }),
  z.object({ action: z.literal("set_category"), fileIds: z.array(z.string().uuid()).min(1).max(500), category: z.string().trim().min(1).max(60) }),
  /** Keep: clear "suggested for deletion". */
  z.object({ action: z.literal("keep"), fileIds: z.array(z.string().uuid()).min(1).max(500) }),
  /** A person trashes (recoverable). Never available to agents. */
  z.object({ action: z.literal("trash"), fileIds: z.array(z.string().uuid()).min(1).max(500) }),
]);

export function spaceFileRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("/:orgId/*", requireOrg(deps));

  async function spaceOr404(orgId: string, spaceId: string) {
    if (!z.string().uuid().safeParse(spaceId).success) throw new HTTPException(404, { message: "Space not found." });
    const space = await scoped(deps.db, orgId).first(spaces, eq(spaces.id, spaceId));
    if (!space) throw new HTTPException(404, { message: "Space not found." });
    return space;
  }

  app.get("/:orgId/spaces/:spaceId/files", requirePermission("file", "view"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) throw new HTTPException(400, { message: q.error.issues[0]?.message ?? "Invalid query." });
    const { status, flag, category, q: text, limit, offset, ids } = q.data;
    const conds: SQL[] = [eq(files.spaceId, space.id)];
    if (ids) conds.push(ids.length ? inArray(files.id, ids) : sql`false`);
    else conds.push(status ? eq(files.status, status) : sql`${files.status} <> 'trashed'`);
    if (flag) conds.push(sql`${flag} = any(${files.flags})`);
    if (category) conds.push(eq(files.category, category));
    if (text) conds.push(or(ilike(files.name, `%${text.replace(/[%_\\]/g, "\\$&")}%`), ilike(files.path, `%${text.replace(/[%_\\]/g, "\\$&")}%`)) as SQL);
    const s = scoped(deps.db, orgId);
    const where = s.where(files, and(...conds) as SQL);
    const rows = await deps.db.select().from(files).where(where).orderBy(asc(files.path)).limit(limit).offset(offset);
    const [total] = await deps.db.select({ n: count() }).from(files).where(where);
    return c.json({ files: rows.map(publicFile), total: total?.n ?? 0 });
  });

  /** Progress and counts for the space header (polled while a scan runs). */
  app.get("/:orgId/spaces/:spaceId/status", requirePermission("file", "view"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    const s = scoped(deps.db, orgId);
    const inSpace = (extra?: SQL) => s.where(files, and(eq(files.spaceId, space.id), sql`${files.status} <> 'trashed'`, extra) as SQL);
    const n = async (extra?: SQL) => (await deps.db.select({ n: count() }).from(files).where(inSpace(extra)))[0]?.n ?? 0;
    let adapter: { readOnly: boolean; error: string | null } = { readOnly: false, error: null };
    try {
      adapter = { readOnly: Boolean(deps.adapterFor(space).readOnly), error: null };
    } catch (err) {
      adapter = { readOnly: true, error: err instanceof Error ? err.message : String(err) };
    }
    const queue = deps.queues ? await deps.queues.indexing.getJobCounts("active", "waiting", "delayed").catch(() => null) : null;
    return c.json({
      total: await n(),
      analyzed: await n(isNotNull(files.analyzedAt)),
      aiAnalyzed: await n(isNotNull(files.aiAnalyzedAt)),
      pendingAnalysis: await n(isNull(files.analyzedAt)),
      needsReview: await n(eq(files.status, "needs_review")),
      flagged: await n(sql`cardinality(${files.flags}) > 0`),
      lastScanAt: space.syncCursor ? Number(space.syncCursor) : null,
      scanning: queue ? (queue.active ?? 0) + (queue.waiting ?? 0) + (queue.delayed ?? 0) > 0 : false,
      adapter,
    });
  });

  /** Duplicate groups (exact + near) with a suggested file to keep. */
  app.get("/:orgId/spaces/:spaceId/duplicates", requirePermission("file", "view"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    const { thresholds } = await loadOrgSettings(deps.db, orgId, deps.encryptionKey);
    const rows = await scoped(deps.db, orgId).select(files, and(eq(files.spaceId, space.id), sql`${files.status} <> 'trashed'`) as SQL);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const indexed = rows.map(toEngineFile);
    const groups = [...exactGroups(indexed), ...nearGroups(indexed, thresholds.nearDuplicateDistance)].map((g) => ({
      kind: g.kind,
      keep: publicFile(byId.get(String(g.keep.id))!),
      others: g.others.map((o) => publicFile(byId.get(String(o.id))!)),
    }));
    return c.json({ groups });
  });

  /** Scan the space and analyze new/changed files (and run AI when configured). */
  app.post("/:orgId/spaces/:spaceId/scan", requirePermission("file", "organize"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    try {
      deps.adapterFor(space);
    } catch (err) {
      throw new HTTPException(409, { message: err instanceof Error ? err.message : String(err) });
    }
    if (!deps.queues) throw new HTTPException(409, { message: "The job queue (Redis) isn't reachable, so the scan can't start." });
    const body = z.object({ withAI: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    const job: IndexJob = { orgId, spaceId: space.id, withAI: body.withAI };
    await deps.queues.indexing.add("index", job, { jobId: `index_${space.id}_${Date.now()}`, removeOnComplete: true, removeOnFail: 100, attempts: 2 });
    return c.json({ queued: true }, 202);
  });

  /** Review actions, as plans through the engine (the click is the approval). */
  app.post("/:orgId/spaces/:spaceId/review", requirePermission("file", "organize"), async (c) => {
    const org = c.get("org");
    const user = c.get("user")!;
    const space = await spaceOr404(org.id, c.req.param("spaceId"));
    const parsed = ReviewBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const body = parsed.data;
    const rows = await scoped(deps.db, org.id).select(files, and(eq(files.spaceId, space.id), inArray(files.id, body.fileIds)) as SQL);
    if (rows.length !== new Set(body.fileIds).size) throw new HTTPException(404, { message: "Some files are not in this space." });

    let input: Omit<PlanInput, "source" | "actor">;
    switch (body.action) {
      case "accept":
        input = { spaceId: space.id, summary: `Accept ${rows.length === 1 ? "1 suggestion" : `${rows.length} suggestions`}`, steps: rows.map((f) => ({ fileId: f.id, action: "category" as const, to: f.category ?? "Uncategorized", before: f.category ?? "—", after: f.category ?? "Uncategorized" })) };
        break;
      case "set_category":
        input = { spaceId: space.id, summary: `Categorize ${rows.length === 1 ? "1 file" : `${rows.length} files`} as ${body.category}`, steps: rows.map((f) => ({ fileId: f.id, action: "category" as const, to: body.category, before: f.category ?? "—", after: body.category })) };
        break;
      case "keep":
        input = {
          spaceId: space.id,
          summary: `Keep ${rows.length === 1 ? "1 file" : `${rows.length} files`}`,
          steps: rows.filter((f) => f.flags.includes("suggested_delete")).map((f) => ({ fileId: f.id, action: "unflag" as const, to: "suggested_delete" satisfies FileFlag, before: "Suggested for deletion", after: "Kept" })),
        };
        break;
      case "trash":
        if (!can(org.role, "file", "trash")) throw new HTTPException(403, { message: "Your role can't move files to the Trash." });
        input = { spaceId: space.id, summary: `Move ${rows.length === 1 ? "1 file" : `${rows.length} files`} to the Trash`, steps: rows.map((f) => ({ fileId: f.id, action: "trash" as const, before: f.path, after: "Trash" })) };
        break;
    }
    if (input.steps.length === 0) return c.json({ done: 0, failed: 0, conflicted: 0, errors: [], batchId: null });

    const engine = createEngine({ store: createPgEngineStore(deps.db, org.id), adapterFor: async () => deps.adapterFor(space) });
    const approver: Approver = { userId: user.id, role: org.role };
    try {
      const res = await engine.run(input, approver);
      // After a manual recategorization the UI offers "Make this a rule?" pre-filled from the first file.
      const example = body.action === "set_category" ? rows[0]! : null;
      const ruleHint = example
        ? { category: body.action === "set_category" ? body.category : "", ext: example.ext, folder: example.path.includes("/") ? example.path.slice(0, example.path.lastIndexOf("/")) : "", docType: example.entities?.docType ?? null }
        : null;
      return c.json({ planId: res.planId, batchId: res.batchId, status: res.status, done: res.done, failed: res.failed, conflicted: res.conflicted, errors: res.errors, ruleHint });
    } catch (err) {
      if (err instanceof EngineError) throw new HTTPException(err.code === "forbidden" ? 403 : 409, { message: err.message });
      throw err;
    }
  });

  /**
   * File content, for previews and downloads. Always sent as an attachment with nosniff (never rendered by the API
   * origin); the web app shows previews from a blob. Read-only: nothing changes.
   */
  app.get("/:orgId/spaces/:spaceId/files/:fileId/content", requirePermission("file", "view"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    const fileId = c.req.param("fileId");
    const file = z.string().uuid().safeParse(fileId).success ? await scoped(deps.db, orgId).first(files, and(eq(files.id, fileId), eq(files.spaceId, space.id)) as SQL) : undefined;
    if (!file || file.status === "trashed") throw new HTTPException(404, { message: "File not found." });
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await deps.adapterFor(space).download({ id: file.providerRef });
    } catch (err) {
      throw new HTTPException(409, { message: err instanceof Error ? err.message : "The file can't be read right now." });
    }
    const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return new Response(stream, {
      headers: {
        "content-type": contentTypeOf(file.ext),
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=60",
        ...(file.size ? { "content-length": String(file.size) } : {}),
      },
    });
  });

  /** Audit log of this space, newest first, with "undone by" derived from undo events (the log is append-only). */
  app.get("/:orgId/spaces/:spaceId/audit", requirePermission("audit", "view"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    const limit = Math.min(500, Number(c.req.query("limit") ?? 200) || 200);
    const rows = await deps.db.execute<{ id: string; at: Date; actor: string; action: string; file_ids: string[]; before: { display?: string } | null; after: { display?: string } | null; reason: string | null; plan_id: string | null; batch_id: string | null; undoes_event_id: string | null; undone_by: string | null; undone_at: Date | null }>(
      sql`select id, at, actor, action, file_ids, before, after, reason, plan_id, batch_id, undoes_event_id, undone_by, undone_at
          from audit_events_with_undo where organization_id = ${orgId} and space_id = ${space.id} order by seq desc limit ${limit}`,
    );
    return c.json({
      events: rows.map((r) => ({
        id: r.id,
        at: new Date(r.at).getTime(),
        actor: r.actor,
        action: r.action,
        fileIds: r.file_ids,
        before: r.before?.display ?? null,
        after: r.after?.display ?? null,
        reason: r.reason,
        planId: r.plan_id,
        batchId: r.batch_id,
        undoesEventId: r.undoes_event_id,
        undoneBy: r.undone_by,
        undoneAt: r.undone_at ? new Date(r.undone_at).getTime() : null,
      })),
    });
  });

  /** Undo a batch made in this space (e.g. from an undo toast). */
  app.post("/:orgId/spaces/:spaceId/undo", requirePermission("file", "organize"), async (c) => {
    const org = c.get("org");
    const space = await spaceOr404(org.id, c.req.param("spaceId"));
    const { batchId } = z.object({ batchId: z.string().uuid() }).parse(await c.req.json().catch(() => ({})));
    const engine = createEngine({ store: createPgEngineStore(deps.db, org.id), adapterFor: async () => deps.adapterFor(space) });
    try {
      const res = await engine.undo({ batchId }, { userId: c.get("user")!.id, role: org.role }, { spaceId: space.id });
      return c.json({ done: res.done, failed: res.failed, conflicted: res.conflicted, errors: res.errors });
    } catch (err) {
      if (err instanceof EngineError) throw new HTTPException(err.code === "nothing_to_undo" ? 409 : 403, { message: err.message });
      throw err;
    }
  });

  return app;
}
