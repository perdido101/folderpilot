/**
 * The core engine's EngineStore over Postgres, for server-side spaces (Cloud, Connect, self-hosted Private).
 * Every query goes through `scoped(db, orgId)`, so a store instance can only ever see one organization.
 * `audit_events` is append-only (enforced by a trigger); undo writes new rows with `undoes_event_id`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, eq, gte, inArray, isNull, like, notInArray, desc, type SQL } from "drizzle-orm";
import {
  kindOf,
  type AuditEvent,
  type AuditQuery,
  type EngineFile,
  type EngineStore,
  type FileFlag,
  type FilePatch,
  type Id,
  type NewAuditEvent,
  type NewPlan,
  type NewRule,
  type Plan,
  type PlanStep,
  type Rule,
  type StepAction,
  type TrashRecord,
} from "@folderpilot/core";
import type { Database } from "./client";
import { auditEvents, files, plans, planSteps, rules, trashItems } from "./schema";
import { scoped } from "./scoped";

/** before/after columns are jsonb: display text, machine value and storage version. */
interface Side {
  display?: string;
  value?: string;
  version?: string;
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : undefined);
const date = (n: number | undefined) => (n === undefined ? undefined : new Date(n));
const str = (id: Id) => String(id);
/** Organization-wide plans (e.g. rule changes) have no space: "" in the engine, null in Postgres. */
const spaceOrNull = (id: Id) => (id === "" ? null : String(id));
/** Copy only defined values (drizzle treats undefined as "leave as is", which is what we want for optional fields). */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

type FileRow = typeof files.$inferSelect;
type PlanRow = typeof plans.$inferSelect;
type StepRow = typeof planSteps.$inferSelect;
type AuditRow = typeof auditEvents.$inferSelect;
type RuleRow = typeof rules.$inferSelect;

/** A `files` row as the engine, rules and analysis see it. */
export function toEngineFile(f: FileRow): EngineFile {
  return defined({
    id: f.id,
    spaceId: f.spaceId,
    ref: { id: f.providerRef },
    version: f.version ?? undefined,
    path: f.path,
    name: f.name,
    ext: f.ext,
    kind: kindOf(f.ext),
    size: f.size,
    mtime: ms(f.mtime) ?? 0,
    status: f.status,
    flags: f.flags as FileFlag[],
    tags: f.tags,
    analyzedLocally: f.analyzedAt !== null,
    sha256: f.sha256 ?? undefined,
    dhash: f.dhash ?? undefined,
    blurScore: f.blurScore ?? undefined,
    brightness: f.brightness ?? undefined,
    width: f.width ?? undefined,
    height: f.height ?? undefined,
    exif: f.exif ?? undefined,
    textExcerpt: f.textExcerpt ?? undefined,
    category: f.category ?? undefined,
    caption: f.caption ?? undefined,
    client: f.entities?.client,
    docType: f.entities?.docType,
    categorySource: f.categorySource ?? undefined,
    flagReason: f.flagReason ?? undefined,
  });
}

function toStep(s: StepRow): PlanStep {
  return defined({
    seq: s.seq,
    status: s.status,
    action: s.action as StepAction,
    fileId: s.fileId ?? undefined,
    from: s.fromValue ?? undefined,
    to: s.toValue ?? undefined,
    before: s.before ?? undefined,
    after: s.after ?? undefined,
    expectVersion: s.expectVersion ?? undefined,
    actor: s.actor ?? undefined,
    error: s.error ?? undefined,
    undoes: s.undoesEventId ?? undefined,
  });
}

function toPlan(p: PlanRow, steps: StepRow[]): Plan {
  return defined({
    id: p.id,
    spaceId: p.spaceId ?? "",
    source: p.source,
    actor: p.actor,
    summary: p.summary,
    reason: p.reason ?? undefined,
    status: p.status,
    steps: steps.map(toStep),
    createdAt: p.createdAt.getTime(),
    approvedBy: p.approvedBy ?? undefined,
    approvedAt: ms(p.approvedAt),
    executedAt: ms(p.executedAt),
    batchId: p.batchId ?? undefined,
  });
}

function toAuditEvent(r: AuditRow): AuditEvent {
  const before = (r.before ?? {}) as Side;
  const after = (r.after ?? {}) as Side;
  return defined({
    id: r.id,
    seq: r.seq,
    at: r.at.getTime(),
    spaceId: r.spaceId ?? "",
    actor: r.actor,
    action: r.action as AuditEvent["action"],
    fileIds: r.fileIds,
    before: before.display,
    after: after.display,
    from: before.value,
    to: after.value,
    fromVersion: before.version,
    toVersion: after.version,
    reason: r.reason ?? undefined,
    planId: r.planId ?? undefined,
    batchId: r.batchId ?? "",
    undoesEventId: r.undoesEventId ?? undefined,
  });
}

/** A `rules` row as the rules engine sees it. */
export function toRule(r: RuleRow): Rule {
  return defined({
    id: r.id,
    type: r.type,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    match: r.match,
    conditions: r.conditions,
    actions: r.actions,
    naturalText: r.naturalText ?? undefined,
    createdBy: r.createdBy.startsWith("agent") ? "agent" : "user",
    createdAt: r.createdAt.getTime(),
    mode: r.mode,
    scopeSpaceId: r.scopeSpaceId ?? undefined,
    schedule: r.schedule,
    lastRunAt: ms(r.lastRunAt),
    archived: r.archivedAt !== null,
  });
}

/** Rule fields stored as columns (shared by create and put). */
function ruleValues(rule: NewRule | Rule) {
  return {
    type: rule.type,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    match: rule.match,
    conditions: rule.conditions,
    actions: rule.actions,
    naturalText: rule.naturalText ?? null,
    mode: rule.mode ?? "suggest",
    // null arrives from JSON rule updates that clear the scope.
    scope: rule.scopeSpaceId == null ? ("org" as const) : ("space" as const),
    scopeSpaceId: rule.scopeSpaceId == null ? null : String(rule.scopeSpaceId),
    schedule: rule.schedule ?? "none",
    lastRunAt: rule.lastRunAt === undefined ? null : new Date(rule.lastRunAt),
  };
}

function stepValues(planId: string, s: PlanStep) {
  return {
    planId,
    seq: s.seq,
    fileId: s.fileId === undefined ? null : str(s.fileId),
    action: s.action,
    fromValue: s.from ?? null,
    toValue: s.to ?? null,
    before: s.before ?? null,
    after: s.after ?? null,
    expectVersion: s.expectVersion ?? null,
    undoesEventId: s.undoes === undefined ? null : str(s.undoes),
    actor: s.actor ?? null,
    status: s.status,
    error: s.error ?? null,
  };
}

export function createPgEngineStore(db: Database, organizationId: string): EngineStore {
  const tx = new AsyncLocalStorage<Database>();
  const conn = () => tx.getStore() ?? db;
  const sc = () => scoped(conn(), organizationId);

  async function stepsOf(planId: string) {
    return conn().select().from(planSteps).where(sc().where(planSteps, eq(planSteps.planId, planId))).orderBy(asc(planSteps.seq));
  }

  return {
    transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (tx.getStore()) return fn();
      return db.transaction((t) => tx.run(t as unknown as Database, fn));
    },

    async getFile(id) {
      const row = await sc().first(files, eq(files.id, str(id)));
      return row && toEngineFile(row);
    },

    async updateFile(id, patch: FilePatch) {
      const set: Partial<typeof files.$inferInsert> = { updatedAt: new Date() };
      const has = (k: keyof FilePatch) => Object.prototype.hasOwnProperty.call(patch, k);
      if (has("path")) set.path = patch.path!;
      if (has("name")) set.name = patch.name!;
      if (has("ext")) set.ext = patch.ext ?? "";
      if (has("ref") && patch.ref) set.providerRef = patch.ref.id;
      if (has("version")) set.version = patch.version ?? null;
      if (has("status")) set.status = patch.status!;
      if (has("tags")) set.tags = patch.tags ?? [];
      if (has("caption")) set.caption = patch.caption ?? null;
      if (has("category")) set.category = patch.category ?? null;
      if (has("categorySource")) set.categorySource = patch.categorySource ?? null;
      if (has("flags")) set.flags = patch.flags ?? [];
      if (has("flagReason")) set.flagReason = patch.flagReason ?? null;
      // trashedFrom lives in trash_items; kind is derived from ext.
      await sc().update(files, eq(files.id, str(id)), set);
    },

    async insertPlan(plan: NewPlan) {
      const run = async () => {
        const row = await sc().insert(plans, {
          spaceId: spaceOrNull(plan.spaceId),
          source: plan.source,
          actor: plan.actor,
          summary: plan.summary,
          reason: plan.reason ?? null,
          status: plan.status,
          createdAt: new Date(plan.createdAt),
        });
        for (const s of plan.steps) await sc().insert(planSteps, stepValues(row.id, s));
        return row.id;
      };
      return tx.getStore() ? run() : db.transaction((t) => tx.run(t as unknown as Database, run));
    },

    async getPlan(id) {
      const row = await sc().first(plans, eq(plans.id, str(id)));
      return row && toPlan(row, await stepsOf(row.id));
    },

    async updatePlan(id, patch) {
      await sc().update(
        plans,
        eq(plans.id, str(id)),
        defined({
          status: patch.status,
          summary: patch.summary,
          reason: patch.reason,
          approvedBy: patch.approvedBy,
          approvedAt: date(patch.approvedAt),
          executedAt: date(patch.executedAt),
          batchId: patch.batchId,
        }),
      );
    },

    async replaceSteps(id, steps) {
      const keep = steps.map((s) => s.seq);
      const cond: SQL = keep.length ? (and(eq(planSteps.planId, str(id)), notInArray(planSteps.seq, keep)) as SQL) : eq(planSteps.planId, str(id));
      await conn().delete(planSteps).where(sc().where(planSteps, cond));
    },

    async updateStep(planId, seq, patch) {
      await sc().update(
        planSteps,
        and(eq(planSteps.planId, str(planId)), eq(planSteps.seq, seq)) as SQL,
        defined({ status: patch.status, error: patch.error === undefined ? undefined : patch.error || null, expectVersion: patch.expectVersion }),
      );
    },

    async appendAudit(e: NewAuditEvent) {
      const row = await sc().insert(auditEvents, {
        at: new Date(e.at),
        spaceId: spaceOrNull(e.spaceId),
        actor: e.actor,
        action: e.action,
        fileIds: e.fileIds.map(str),
        before: defined({ display: e.before, value: e.from, version: e.fromVersion }),
        after: defined({ display: e.after, value: e.to, version: e.toVersion }),
        reason: e.reason ?? null,
        planId: e.planId === undefined ? null : str(e.planId),
        batchId: e.batchId,
        undoesEventId: e.undoesEventId === undefined ? null : str(e.undoesEventId),
      });
      return row.id;
    },

    async getAuditEvents(ids) {
      if (!ids.length) return [];
      return (await sc().select(auditEvents, inArray(auditEvents.id, ids.map(str)))).map(toAuditEvent);
    },

    async findAudit(q: AuditQuery) {
      const conds: SQL[] = [];
      if (q.spaceId !== undefined) conds.push(eq(auditEvents.spaceId, str(q.spaceId)));
      if (q.batchId !== undefined) conds.push(eq(auditEvents.batchId, q.batchId));
      if (q.planId !== undefined) conds.push(eq(auditEvents.planId, str(q.planId)));
      if (q.actorPrefix !== undefined) conds.push(like(auditEvents.actor, `${q.actorPrefix.replace(/[%_\\]/g, "\\$&")}%`));
      if (q.since !== undefined) conds.push(gte(auditEvents.at, new Date(q.since)));
      const rows = await conn()
        .select()
        .from(auditEvents)
        .where(sc().where(auditEvents, conds.length ? (and(...conds) as SQL) : undefined))
        .orderBy(asc(auditEvents.seq));
      return rows.map(toAuditEvent);
    },

    async findUndoEvents(eventIds) {
      if (!eventIds.length) return [];
      return (await sc().select(auditEvents, inArray(auditEvents.undoesEventId, eventIds.map(str)))).map(toAuditEvent);
    },

    async putTrash(t: TrashRecord) {
      await sc().insert(trashItems, {
        fileId: str(t.fileId),
        spaceId: str(t.spaceId),
        originalPath: t.originalPath,
        trashedBy: t.trashedBy,
        trashedAt: new Date(t.trashedAt),
        purgeAfter: new Date(t.purgeAfter),
      });
    },

    async getTrash(fileId) {
      const [row] = await conn()
        .select()
        .from(trashItems)
        .where(sc().where(trashItems, and(eq(trashItems.fileId, str(fileId)), isNull(trashItems.restoredAt)) as SQL))
        .orderBy(desc(trashItems.trashedAt))
        .limit(1);
      return row && { fileId: row.fileId, spaceId: row.spaceId, originalPath: row.originalPath, trashedBy: row.trashedBy, trashedAt: row.trashedAt.getTime(), purgeAfter: row.purgeAfter.getTime() };
    },

    /** Restored items keep their row (history), marked with restored_at. */
    async clearTrash(fileId) {
      await sc().update(trashItems, and(eq(trashItems.fileId, str(fileId)), isNull(trashItems.restoredAt)) as SQL, { restoredAt: new Date() });
    },

    async createRule(rule: NewRule) {
      const row = await sc().insert(rules, { ...ruleValues(rule), archivedAt: rule.archived ? new Date() : null, createdBy: rule.createdBy, createdAt: new Date(rule.createdAt) });
      return row.id;
    },

    async getRule(id) {
      const row = await sc().first(rules, eq(rules.id, str(id)));
      return row && toRule(row);
    },

    async putRule(rule: Rule) {
      const prev = await sc().first(rules, eq(rules.id, str(rule.id)));
      // Keep the original archive time while a rule stays archived.
      const values = { ...ruleValues(rule), archivedAt: rule.archived ? (prev?.archivedAt ?? new Date()) : null, updatedAt: new Date() };
      if (prev) await sc().update(rules, eq(rules.id, prev.id), values);
      else await sc().insert(rules, { ...values, id: str(rule.id), createdBy: rule.createdBy, createdAt: new Date(rule.createdAt) });
    },

    async removeRule(id) {
      await conn().delete(rules).where(sc().where(rules, eq(rules.id, str(id))));
    },
  };
}
