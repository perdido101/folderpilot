/**
 * Rules (spec §8) and plans waiting for approval (spec §2).
 * - Rule changes are plans through the engine (rule_create / rule_update): audited and undoable. Rules are archived, never deleted.
 * - Switching a rule to "auto" needs an admin (spec §2: admins decide what may run without approval).
 * - "Test rule" is a dry-run (nothing changes); "Run" executes auto rules and turns suggest rules into pending plans.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { proposeStructuredRule, RuleProposalError } from "@folderpilot/ai";
import { can, createEngine, dryRun, EngineError, OPS_BY_FIELD, ruleProblem, type Approver, type ConditionField, type ConditionOp, type NewRule, type Rule } from "@folderpilot/core";
import { activeStructuredRules, auditEvents, createPgEngineStore, files, loadOrgSettings, plans, planSteps, rules, runRulesOnFiles, scoped, spaces, toEngineFile, toRule } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireOrg, requirePermission } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

const FIELDS = Object.keys(OPS_BY_FIELD) as [ConditionField, ...ConditionField[]];
const OPS = [...new Set(Object.values(OPS_BY_FIELD).flat())] as [ConditionOp, ...ConditionOp[]];

const RuleFields = z.object({
  type: z.enum(["structured", "natural"]),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100_000),
  match: z.enum(["all", "any"]),
  conditions: z.array(z.object({ field: z.enum(FIELDS), op: z.enum(OPS), value: z.string().max(500) })).max(20),
  actions: z.array(z.object({ type: z.enum(["move", "rename", "tag", "caption", "set_category", "flag_review"]), value: z.string().max(500) })).max(10),
  naturalText: z.string().max(2000).nullable(),
  mode: z.enum(["suggest", "auto"]),
  scopeSpaceId: z.string().uuid().nullable(),
  schedule: z.enum(["none", "hourly", "daily", "weekly"]),
});
const NewRuleBody = RuleFields.partial({ enabled: true, priority: true, match: true, conditions: true, actions: true, naturalText: true, mode: true, scopeSpaceId: true, schedule: true });
const RuleChanges = RuleFields.omit({ type: true }).partial();

type RuleInput = z.infer<typeof NewRuleBody>;

function toNewRule(b: RuleInput): NewRule {
  const rule: NewRule = {
    type: b.type,
    name: b.name,
    enabled: b.enabled ?? true,
    priority: b.priority ?? 100,
    match: b.match ?? "all",
    conditions: b.type === "structured" ? (b.conditions ?? []) : [],
    actions: b.type === "structured" ? (b.actions ?? []) : [],
    createdBy: "user",
    createdAt: Date.now(),
    mode: b.mode ?? "suggest",
    schedule: b.schedule ?? "none",
  };
  if (b.naturalText) rule.naturalText = b.naturalText;
  if (b.scopeSpaceId) rule.scopeSpaceId = b.scopeSpaceId;
  return rule;
}

/** What the browser sees of a rule. */
function publicRule(r: typeof rules.$inferSelect) {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    match: r.match,
    conditions: r.conditions,
    actions: r.actions,
    naturalText: r.naturalText,
    mode: r.mode,
    scopeSpaceId: r.scopeSpaceId,
    schedule: r.schedule,
    lastRunAt: r.lastRunAt?.getTime() ?? null,
    archived: r.archivedAt !== null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

const bad = (message: string) => new HTTPException(400, { message });
const engineHttp = (err: unknown): never => {
  if (err instanceof EngineError) throw new HTTPException(err.code === "forbidden" ? 403 : err.code === "not_found" ? 404 : 409, { message: err.message });
  throw err;
};
const parse = async <T>(schema: z.ZodType<T>, req: { json(): Promise<unknown> }): Promise<T> => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw bad(parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "));
  return parsed.data;
};
const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

/** Plans with their steps (file names joined), as the browser shows them. */
export async function publicPlans(deps: Deps, orgId: string, planRows: (typeof plans.$inferSelect)[]) {
  const steps = planRows.length
    ? await deps.db
        .select({ step: planSteps, name: files.name })
        .from(planSteps)
        .leftJoin(files, eq(files.id, planSteps.fileId))
        .where(and(eq(planSteps.organizationId, orgId), inArray(planSteps.planId, planRows.map((p) => p.id))))
        .orderBy(planSteps.seq)
    : [];
  return planRows.map((p) => {
    const own = steps.filter((s) => s.step.planId === p.id);
    return {
      id: p.id,
      spaceId: p.spaceId,
      source: p.source,
      actor: p.actor,
      summary: p.summary,
      reason: p.reason,
      status: p.status,
      createdAt: p.createdAt.getTime(),
      batchId: p.batchId,
      fileCount: new Set(own.flatMap((s) => (s.step.fileId ? [s.step.fileId] : []))).size,
      steps: own.slice(0, 500).map(({ step: s, name }) => ({ seq: s.seq, action: s.action, fileId: s.fileId, name: name ?? "", before: s.before ?? "", after: s.after ?? "", status: s.status, error: s.error })),
    };
  });
}

export function ruleRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("/:orgId/*", requireOrg(deps));

  const engineFor = (orgId: string, space?: typeof spaces.$inferSelect) =>
    createEngine({
      store: createPgEngineStore(deps.db, orgId),
      adapterFor: async () => {
        if (!space) throw new EngineError("This change doesn't touch files.", "invalid_plan");
        return deps.adapterFor(space);
      },
    });

  async function spaceOr404(orgId: string, spaceId: string) {
    const space = isUuid(spaceId) ? await scoped(deps.db, orgId).first(spaces, eq(spaces.id, spaceId)) : undefined;
    if (!space) throw new HTTPException(404, { message: "Space not found." });
    return space;
  }

  async function ruleOr404(orgId: string, ruleId: string) {
    const row = isUuid(ruleId) ? await scoped(deps.db, orgId).first(rules, eq(rules.id, ruleId)) : undefined;
    if (!row) throw new HTTPException(404, { message: "Rule not found." });
    return row;
  }

  // ── Rules ──
  app.get("/:orgId/rules", requirePermission("file", "view"), async (c) => {
    const withArchived = c.req.query("archived") === "1";
    const rows = await scoped(deps.db, c.get("org").id).select(rules, withArchived ? undefined : isNull(rules.archivedAt));
    rows.sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
    return c.json({ rules: rows.map(publicRule) });
  });

  app.post("/:orgId/rules", requirePermission("rule", "manage"), async (c) => {
    const org = c.get("org");
    const body = await parse(NewRuleBody, c.req);
    const rule = toNewRule(body);
    const problem = ruleProblem(rule);
    if (problem) throw bad(problem);
    if (rule.mode === "auto" && !can(org.role, "settings", "manage")) throw new HTTPException(403, { message: "Only admins can let a rule run automatically. Save it as Suggest instead." });
    if (body.scopeSpaceId) await spaceOr404(org.id, body.scopeSpaceId);
    const approver: Approver = { userId: c.get("user")!.id, role: org.role };
    const res = await engineFor(org.id)
      .run({ spaceId: "", summary: `Create rule "${rule.name}"`, steps: [{ action: "rule_create", to: JSON.stringify(rule), before: "—", after: rule.name }] }, approver)
      .catch(engineHttp);
    if (res.failed) throw new HTTPException(409, { message: res.errors[0] ?? "The rule couldn't be saved." });
    const [event] = await deps.db.select({ after: auditEvents.after }).from(auditEvents).where(and(eq(auditEvents.organizationId, org.id), eq(auditEvents.planId, String(res.planId))));
    const id = (event?.after as { value?: string } | null)?.value;
    const row = id ? await ruleOr404(org.id, id) : undefined;
    return c.json({ rule: row ? publicRule(row) : null, batchId: res.batchId }, 201);
  });

  /** Edit a rule. Archiving is `{ archived: true }` via DELETE; restoring is undo. */
  async function changeRule(org: { id: string; role: Approver["role"] }, userId: string, ruleId: string, changes: Partial<Rule>, summary: string) {
    const old = toRule(await ruleOr404(org.id, ruleId));
    const next: Rule = { ...old, ...changes };
    const problem = ruleProblem(next);
    if (problem) throw bad(problem);
    // Admins decide what runs without approval. Anyone who manages rules may still pause or archive an auto rule.
    const onlyStops = Object.keys(changes).every((k) => (k === "enabled" && changes.enabled === false) || k === "archived");
    if ((next.mode ?? "suggest") === "auto" && !onlyStops && !can(org.role, "settings", "manage")) {
      throw new HTTPException(403, { message: "Only admins can change a rule that runs automatically." });
    }
    if (changes.scopeSpaceId) await spaceOr404(org.id, String(changes.scopeSpaceId));
    const approver: Approver = { userId, role: org.role };
    const res = await engineFor(org.id)
      .run({ spaceId: "", summary, steps: [{ action: "rule_update", to: JSON.stringify({ id: old.id, changes }), before: old.name, after: next.name }] }, approver)
      .catch(engineHttp);
    if (res.failed) throw new HTTPException(409, { message: res.errors[0] ?? "The rule couldn't be saved." });
    return { rule: publicRule(await ruleOr404(org.id, ruleId)), batchId: res.batchId };
  }

  app.put("/:orgId/rules/:ruleId", requirePermission("rule", "manage"), async (c) => {
    const body = await parse(RuleChanges, c.req);
    // JSON drops undefined; null clears the scope / natural text.
    const changes = { ...body } as Partial<Rule> & Record<string, unknown>;
    const name = body.name ?? (await ruleOr404(c.get("org").id, c.req.param("ruleId"))).name;
    return c.json(await changeRule(c.get("org"), c.get("user")!.id, c.req.param("ruleId"), changes, `Edit rule "${name}"`));
  });

  app.delete("/:orgId/rules/:ruleId", requirePermission("rule", "manage"), async (c) => {
    const row = await ruleOr404(c.get("org").id, c.req.param("ruleId"));
    return c.json(await changeRule(c.get("org"), c.get("user")!.id, row.id, { archived: true, enabled: false }, `Archive rule "${row.name}"`));
  });

  /** Rule changes (organization-wide audit events, newest first). */
  app.get("/:orgId/rules/history", requirePermission("audit", "view"), async (c) => {
    const orgId = c.get("org").id;
    const rows = await deps.db.execute<{ id: string; at: Date; actor: string; action: string; before: { display?: string } | null; after: { display?: string } | null; reason: string | null; batch_id: string | null; undoes_event_id: string | null; undone_by: string | null }>(
      sql`select id, at, actor, action, before, after, reason, batch_id, undoes_event_id, undone_by
          from audit_events_with_undo where organization_id = ${orgId} and action in ('rule_create', 'rule_update') order by seq desc limit 200`,
    );
    return c.json({
      events: rows.map((r) => ({ id: r.id, at: new Date(r.at).getTime(), actor: r.actor, action: r.action, before: r.before?.display ?? null, after: r.after?.display ?? null, reason: r.reason, batchId: r.batch_id, undoesEventId: r.undoes_event_id, undoneBy: r.undone_by })),
    });
  });

  /** Undo a rule change (create, edit or archive). */
  app.post("/:orgId/rules/undo", requirePermission("rule", "manage"), async (c) => {
    const org = c.get("org");
    const { batchId } = await parse(z.object({ batchId: z.string().uuid() }), c.req);
    const events = await deps.db.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.organizationId, org.id), eq(auditEvents.batchId, batchId)));
    if (!events.length) throw new HTTPException(404, { message: "Nothing to undo." });
    if (events.some((e) => e.action !== "rule_create" && e.action !== "rule_update")) throw bad("That change isn't a rule change; undo it from its space.");
    const res = await engineFor(org.id).undo({ batchId }, { userId: c.get("user")!.id, role: org.role }).catch(engineHttp);
    return c.json({ done: res.done, failed: res.failed, conflicted: res.conflicted, errors: res.errors });
  });

  /** Dry-run of a saved or unsaved rule: how many files it matches and what would change (nothing is changed). */
  app.post("/:orgId/rules/test", requirePermission("file", "view"), async (c) => {
    const orgId = c.get("org").id;
    const body = await parse(z.object({ rule: NewRuleBody, spaceId: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).default(25) }), c.req);
    const rule: Rule = { ...toNewRule(body.rule), id: "preview" };
    const problem = ruleProblem(rule);
    if (problem) throw bad(problem);
    const spaceId = body.spaceId ?? (rule.scopeSpaceId ? String(rule.scopeSpaceId) : undefined);
    if (spaceId) await spaceOr404(orgId, spaceId);
    const rows = await scoped(deps.db, orgId).select(files, and(spaceId ? eq(files.spaceId, spaceId) : undefined, sql`${files.status} <> 'trashed'`) as SQL);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const { matches, steps } = dryRun(rows.map(toEngineFile), rule);
    return c.json({
      matches: matches.length,
      changes: steps.length,
      steps: steps.slice(0, body.limit).map((s) => ({ fileId: s.fileId, name: byId.get(String(s.fileId))?.name ?? "", action: s.action, before: s.before ?? "", after: s.after ?? "" })),
    });
  });

  /** "Run on folder": auto rules execute, suggest rules become plans waiting for approval. */
  app.post("/:orgId/rules/run", requirePermission("file", "organize"), async (c) => {
    const orgId = c.get("org").id;
    const body = await parse(z.object({ spaceId: z.string().uuid(), ruleId: z.string().uuid().optional(), folder: z.string().max(2000).optional() }), c.req);
    const space = await spaceOr404(orgId, body.spaceId);
    let active = await activeStructuredRules(deps.db, orgId);
    if (body.ruleId) {
      const one = toRule(await ruleOr404(orgId, body.ruleId));
      if (one.archived || one.type !== "structured") throw bad("Only active structured rules can run.");
      active = [{ ...one, enabled: true }];
    }
    const folder = body.folder?.replace(/^\/+|\/+$/g, "");
    const rows = await scoped(deps.db, orgId).select(
      files,
      and(eq(files.spaceId, space.id), sql`${files.status} <> 'trashed'`, folder ? sql`(${files.path} like ${`${folder.replace(/[%_\\]/g, "\\$&")}/%`})` : undefined) as SQL,
    );
    let adapter;
    try {
      adapter = deps.adapterFor(space);
    } catch (err) {
      throw new HTTPException(409, { message: err instanceof Error ? err.message : String(err) });
    }
    const outcomes = await runRulesOnFiles({ db: deps.db, orgId, space, adapter, files: rows, rules: active });
    return c.json({ files: rows.length, outcomes });
  });

  /** Natural-language rule → structured proposal (the organization's AI). Nothing is saved. */
  app.post("/:orgId/rules/convert", requirePermission("rule", "manage"), rateLimit(deps.redis, { prefix: "rule-convert", windowSec: 60, max: 20 }), async (c) => {
    const orgId = c.get("org").id;
    const { text } = await parse(z.object({ text: z.string().trim().min(3).max(2000) }), c.req);
    const provider = deps.ai.forOrg((await loadOrgSettings(deps.db, orgId, deps.encryptionKey)).ai);
    if (!provider) throw new HTTPException(409, { message: "No AI is configured for this organization (Settings → AI)." });
    const used = await deps.db
      .selectDistinct({ category: files.category })
      .from(files)
      .where(and(eq(files.organizationId, orgId), sql`${files.category} is not null`))
      .limit(60);
    try {
      return c.json({ proposal: await proposeStructuredRule(provider, text, used.map((u) => u.category!)) });
    } catch (err) {
      if (err instanceof RuleProposalError) throw new HTTPException(422, { message: err.message });
      deps.log.warn({ orgId, err: err instanceof Error ? err.message : String(err) }, "rule conversion failed");
      throw new HTTPException(502, { message: "The AI request failed." });
    }
  });

  // ── Plans waiting for approval ──
  app.get("/:orgId/spaces/:spaceId/plans", requirePermission("file", "view"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    const status = z.enum(["pending", "approved", "executing", "executed", "partially_failed", "cancelled"]).default("pending").parse(c.req.query("status") ?? undefined);
    const planRows = await deps.db
      .select()
      .from(plans)
      .where(and(eq(plans.organizationId, orgId), eq(plans.spaceId, space.id), eq(plans.status, status)))
      .orderBy(desc(plans.createdAt))
      .limit(50);
    return c.json({ plans: await publicPlans(deps, orgId, planRows) });
  });

  /** One plan (any status), e.g. a Plan Card in the agent chat. */
  app.get("/:orgId/plans/:planId", requirePermission("file", "view"), async (c) => {
    const orgId = c.get("org").id;
    const planId = c.req.param("planId");
    const row = isUuid(planId) ? await scoped(deps.db, orgId).first(plans, eq(plans.id, planId)) : undefined;
    if (!row) throw new HTTPException(404, { message: "Plan not found." });
    const [plan] = await publicPlans(deps, orgId, [row]);
    return c.json({ plan });
  });

  async function planContext(orgId: string, planId: string) {
    const row = isUuid(planId) ? await scoped(deps.db, orgId).first(plans, eq(plans.id, planId)) : undefined;
    if (!row) throw new HTTPException(404, { message: "Plan not found." });
    const space = row.spaceId ? await scoped(deps.db, orgId).first(spaces, eq(spaces.id, row.spaceId)) : undefined;
    return { row, engine: engineFor(orgId, space) };
  }

  app.post("/:orgId/plans/:planId/approve", requirePermission("plan", "approve"), async (c) => {
    const org = c.get("org");
    const { engine } = await planContext(org.id, c.req.param("planId"));
    const planId = c.req.param("planId");
    await engine.approve(planId, { userId: c.get("user")!.id, role: org.role }).catch(engineHttp);
    const res = await engine.execute(planId).catch(engineHttp);
    return c.json({ planId, batchId: res.batchId, status: res.status, done: res.done, failed: res.failed, conflicted: res.conflicted, errors: res.errors });
  });

  /** Edit a pending plan: keep only these steps (unticked rows are dropped). */
  app.post("/:orgId/plans/:planId/keep-steps", requirePermission("plan", "approve"), async (c) => {
    const { engine } = await planContext(c.get("org").id, c.req.param("planId"));
    const { seqs } = await parse(z.object({ seqs: z.array(z.number().int().min(0)).max(10_000) }), c.req);
    await engine.keepSteps(c.req.param("planId"), seqs).catch(engineHttp);
    return c.json({ ok: true });
  });

  app.post("/:orgId/plans/:planId/cancel", requirePermission("plan", "approve"), async (c) => {
    const { engine } = await planContext(c.get("org").id, c.req.param("planId"));
    await engine.cancel(c.req.param("planId")).catch(engineHttp);
    return c.json({ ok: true });
  });

  return app;
}
