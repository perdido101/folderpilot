/** The core engine's EngineStore over this browser's IndexedDB (Dexie). Space id = root folder id. */
import type { AuditEvent, AuditQuery, EngineFile, EngineStore, FilePatch, Id, NewAuditEvent, NewPlan, NewRule, Plan, Rule, TrashRecord } from "@folderpilot/core";
import type { Table, Transaction } from "dexie";
import { db, type AuditRecord, type FileRecord, type PlanRecord, type PlanStep, type TrashRecord as TrashRow } from "../db";
import { parseVersion } from "../storage/local-browser";

const num = (id: Id) => Number(id);
const optNum = (id: Id | undefined) => (id === undefined ? undefined : Number(id));

export function toEngineFile(f: FileRecord): EngineFile {
  return { ...f, spaceId: f.rootId, ref: { id: f.path }, version: `${f.size}-${f.mtime}` };
}

function toPlan(p: PlanRecord): Plan {
  const { rootId, errors: _legacy, ...rest } = p;
  return { ...rest, spaceId: rootId };
}

function toAuditEvent(r: AuditRecord): AuditEvent {
  const { rootId, undone: _legacy, ...rest } = r;
  return { ...rest, seq: r.id, spaceId: rootId };
}

/**
 * Inside `transaction()` every call goes through tables bound to that transaction explicitly
 * (Dexie's implicit zone tracking doesn't survive the engine's async callbacks). Transactions are serialized.
 */
let current: Transaction | null = null;
let queue: Promise<unknown> = Promise.resolve();
const files = () => (current ? (current.table("files") as Table<FileRecord, number>) : db.files);
const plans = () => (current ? (current.table("plans") as Table<PlanRecord, number>) : db.plans);
const audit = () => (current ? (current.table("audit") as Table<AuditRecord, number>) : db.audit);
const trash = () => (current ? (current.table("trash") as Table<TrashRow, number>) : db.trash);
const rules = () => (current ? (current.table("rules") as Table<Rule, Rule["id"]>) : db.rules);

/** Drop keys whose value is undefined, except the ones we want Dexie to clear. */
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const dexieStore: EngineStore = {
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = () =>
      db.transaction("rw", [db.files, db.plans, db.audit, db.trash, db.rules], async (tx) => {
        current = tx;
        try {
          return await fn();
        } finally {
          current = null;
        }
      });
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  },

  async getFile(id) {
    const f = await files().get(num(id));
    return f && toEngineFile(f);
  },

  async updateFile(id, patch: FilePatch) {
    const { ref: _ref, version, ...rest } = patch;
    const changes: Partial<FileRecord> = { ...rest };
    // The index keeps size + mtime; the local version string is derived from them.
    const parsed = version ? parseVersion(version) : null;
    if (parsed) Object.assign(changes, parsed);
    await files().update(num(id), changes);
  },

  async insertPlan(plan: NewPlan) {
    const { spaceId, steps, ...rest } = plan;
    return plans().add({ ...clean(rest), rootId: num(spaceId), steps: steps.map((s) => clean({ ...s, fileId: optNum(s.fileId), undoes: optNum(s.undoes) })) as PlanStep[] });
  },

  async getPlan(id) {
    const p = await plans().get(num(id));
    return p && toPlan(p);
  },

  async updatePlan(id, patch) {
    await plans().update(num(id), patch);
  },

  async replaceSteps(id, steps) {
    await plans().update(num(id), { steps: steps.map((s) => clean({ ...s, fileId: optNum(s.fileId), undoes: optNum(s.undoes) })) as PlanStep[] });
  },

  async updateStep(planId, seq, patch) {
    const plan = await plans().get(num(planId));
    if (!plan) return;
    await plans().update(plan.id, { steps: plan.steps.map((s) => (s.seq === seq ? { ...s, ...patch } : s)) });
  },

  async appendAudit(e: NewAuditEvent) {
    const { spaceId, fileIds, planId, undoesEventId, ...rest } = e;
    return audit().add(
      clean({ ...rest, rootId: num(spaceId), fileIds: fileIds.map(num), planId: optNum(planId), undoesEventId: optNum(undoesEventId) }) as Omit<AuditRecord, "id">,
    );
  },

  async getAuditEvents(ids) {
    return (await audit().bulkGet(ids.map(num))).flatMap((r) => (r ? [toAuditEvent(r)] : []));
  },

  async findAudit(q: AuditQuery) {
    const base =
      q.batchId !== undefined
        ? audit().where("batchId").equals(q.batchId)
        : q.planId !== undefined
          ? audit().where("planId").equals(num(q.planId))
          : q.spaceId !== undefined
            ? audit().where("rootId").equals(num(q.spaceId))
            : audit().where("at").aboveOrEqual(q.since ?? 0);
    const rows = await base
      .filter(
        (r) =>
          (q.spaceId === undefined || r.rootId === num(q.spaceId)) &&
          (q.actorPrefix === undefined || r.actor.startsWith(q.actorPrefix)) &&
          (q.since === undefined || r.at >= q.since),
      )
      .toArray();
    return rows.map(toAuditEvent);
  },

  async findUndoEvents(eventIds) {
    const ids = eventIds.map(num);
    const undo = (await audit().where("undoesEventId").anyOf(ids).toArray()).map(toAuditEvent);
    // Rows undone before undo events existed (v2) carry a legacy flag instead; report them as undone too.
    const legacy = (await audit().bulkGet(ids)).flatMap((r) => (r?.undone ? [{ ...toAuditEvent(r), action: "undo" as const, undoesEventId: r.id }] : []));
    return [...undo, ...legacy];
  },

  async putTrash(t: TrashRecord) {
    await trash().put({ fileId: num(t.fileId), rootId: num(t.spaceId), originalPath: t.originalPath, trashedBy: t.trashedBy, trashedAt: t.trashedAt, purgeAfter: t.purgeAfter });
  },

  async getTrash(fileId) {
    const t = await trash().get(num(fileId));
    return t && { fileId: t.fileId, spaceId: t.rootId, originalPath: t.originalPath, trashedBy: t.trashedBy, trashedAt: t.trashedAt, purgeAfter: t.purgeAfter };
  },

  async clearTrash(fileId) {
    await trash().delete(num(fileId));
  },

  createRule: (rule: NewRule) => rules().add(rule as Rule) as Promise<Rule["id"]>,
  getRule: (id) => rules().get(id as never),
  async putRule(rule) {
    await rules().put(rule);
  },
  async removeRule(id) {
    await rules().delete(id as never);
  },
};
