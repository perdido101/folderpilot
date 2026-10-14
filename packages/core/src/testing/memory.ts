/**
 * In-memory StorageAdapter and EngineStore for tests (core, web and db packages).
 * MemoryAdapter behaves like a cloud provider: stable ids, versions that change on edit, a recoverable trash.
 */
import type { NewRule, Rule } from "../rules/types";
import { ConflictError, NotFoundError, ReadOnlyError, joinPath, splitPath, type ChangeEvent, type FileEntry, type FileRef, type Page, type StorageAdapter, type WriteOptions } from "../storage/types";
import type { AdapterId, Id } from "../types";
import type { AuditEvent, AuditQuery, EngineFile, EngineStore, FilePatch, NewAuditEvent, NewPlan, Plan, PlanStep, TrashRecord } from "../engine/types";

interface Node {
  id: string;
  path: string;
  isFolder: boolean;
  content: string;
  version: number;
  mtime: number;
  trashed: boolean;
}

export class MemoryAdapter implements StorageAdapter {
  readonly id: AdapterId = "fp-cloud";
  readonly readOnly: boolean;
  readonly nodes = new Map<string, Node>();
  /** Every write, in order, e.g. "move a.txt → b/a.txt". */
  readonly writes: string[] = [];
  /** Throw this error from the next write (simulates a provider failure). */
  failNextWrite: Error | null = null;
  private seq = 0;

  constructor(files: Record<string, string> = {}, opts: { readOnly?: boolean } = {}) {
    this.readOnly = opts.readOnly ?? false;
    for (const [path, content] of Object.entries(files)) this.put(path, content);
  }

  // ── test helpers ──
  put(path: string, content: string): FileEntry {
    const { dir, name } = splitPath(path);
    if (dir) this.mkdirs(dir);
    const node: Node = { id: `n${++this.seq}`, path: joinPath(dir, name), isFolder: false, content, version: 1, mtime: 1_700_000_000_000, trashed: false };
    this.nodes.set(node.id, node);
    return this.entry(node);
  }
  /** Change a file behind FolderPilot's back. */
  edit(path: string, content: string) {
    const node = this.live(path);
    if (!node) throw new Error(`no ${path}`);
    node.content = content;
    node.version++;
    node.mtime++;
  }
  /** Move a file behind FolderPilot's back. */
  relocate(path: string, to: string) {
    const node = this.live(path);
    if (!node) throw new Error(`no ${path}`);
    node.path = to;
  }
  paths(): string[] {
    return [...this.nodes.values()].filter((n) => !n.isFolder && !n.trashed).map((n) => n.path).sort();
  }
  trashed(): string[] {
    return [...this.nodes.values()].filter((n) => n.trashed).map((n) => n.path).sort();
  }
  entryAt(path: string): FileEntry {
    const node = this.live(path);
    if (!node) throw new Error(`no ${path}`);
    return this.entry(node);
  }

  private mkdirs(dir: string) {
    let cur = "";
    for (const part of dir.split("/")) {
      cur = joinPath(cur, part);
      if (!this.live(cur)) this.nodes.set(`n${++this.seq}`, { id: `n${this.seq}`, path: cur, isFolder: true, content: "", version: 1, mtime: 0, trashed: false });
    }
  }
  private live(path: string) {
    for (const n of this.nodes.values()) if (!n.trashed && n.path === path) return n;
    return undefined;
  }
  private node(ref: FileRef) {
    const n = this.nodes.get(ref.id);
    if (!n) throw new NotFoundError(`Not found: ${ref.id}`);
    return n;
  }
  private entry(n: Node): FileEntry {
    return { ref: { id: n.id }, path: n.path, name: splitPath(n.path).name, isFolder: n.isFolder, size: n.content.length, mtime: n.mtime, version: `v${n.version}` };
  }
  private free(path: string) {
    if (!this.live(path)) return path;
    const { dir, name } = splitPath(path);
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 2; ; n++) {
      const candidate = joinPath(dir, `${base} (${n})${ext}`);
      if (!this.live(candidate)) return candidate;
    }
  }
  private guard(n: Node, opts?: WriteOptions) {
    if (this.readOnly) throw new ReadOnlyError();
    if (this.failNextWrite) {
      const err = this.failNextWrite;
      this.failNextWrite = null;
      throw err;
    }
    if (opts && `v${n.version}` !== opts.expectVersion) throw new ConflictError(`${n.path} changed`, `v${n.version}`);
  }
  private setPath(n: Node, path: string) {
    const old = n.path;
    n.path = path;
    if (n.isFolder) for (const c of this.nodes.values()) if (c.path.startsWith(`${old}/`)) c.path = path + c.path.slice(old.length);
  }

  // ── StorageAdapter ──
  async list(path: string): Promise<Page<FileEntry>> {
    const prefix = path ? `${path}/` : "";
    return { items: [...this.nodes.values()].filter((n) => !n.trashed && n.path.startsWith(prefix) && !n.path.slice(prefix.length).includes("/")).map((n) => this.entry(n)) };
  }
  async stat(ref: FileRef) {
    return this.entry(this.node(ref));
  }
  async resolve(path: string) {
    const n = this.live(path);
    return n ? this.entry(n) : null;
  }
  async readThumbnail() {
    return null;
  }
  async readText(ref: FileRef, maxChars: number) {
    return this.node(ref).content.slice(0, maxChars);
  }
  async download(ref: FileRef) {
    const content = this.node(ref).content;
    return new Blob([content]).stream();
  }
  async move(ref: FileRef, newParent: FileRef, opts: WriteOptions & { newName?: string }) {
    const n = this.node(ref);
    this.guard(n, opts);
    const parentPath = newParent.id ? this.node(newParent).path : "";
    const target = this.free(joinPath(parentPath, opts.newName ?? splitPath(n.path).name));
    this.writes.push(`move ${n.path} → ${target}`);
    this.setPath(n, target);
    return this.entry(n);
  }
  async rename(ref: FileRef, newName: string, opts: WriteOptions) {
    const n = this.node(ref);
    this.guard(n, opts);
    const target = this.free(joinPath(splitPath(n.path).dir, newName));
    this.writes.push(`rename ${n.path} → ${target}`);
    this.setPath(n, target);
    return this.entry(n);
  }
  async createFolder(parent: FileRef, name: string) {
    if (this.readOnly) throw new ReadOnlyError();
    const path = joinPath(parent.id ? this.node(parent).path : "", name);
    const existing = this.live(path);
    if (existing) return this.entry(existing);
    this.writes.push(`mkdir ${path}`);
    this.mkdirs(path);
    return this.entry(this.live(path)!);
  }
  async trash(ref: FileRef, opts: WriteOptions) {
    const n = this.node(ref);
    this.guard(n, opts);
    this.writes.push(`trash ${n.path}`);
    n.trashed = true;
    n.path = `.trash/${n.id}/${splitPath(n.path).name}`;
    return this.entry(n);
  }
  async restore(ref: FileRef, originalPath: string) {
    const n = this.node(ref);
    this.guard(n);
    const { dir } = splitPath(originalPath);
    if (dir) this.mkdirs(dir);
    const target = this.free(originalPath);
    this.writes.push(`restore ${target}`);
    n.trashed = false;
    n.path = target;
    return this.entry(n);
  }
  async changes(cursor?: string): Promise<{ entries: ChangeEvent[]; cursor: string }> {
    return { entries: [], cursor: cursor ?? "0" };
  }
}

interface State {
  files: Map<string, EngineFile>;
  plans: Map<string, Plan>;
  audit: AuditEvent[];
  trash: Map<string, TrashRecord>;
  rules: Map<string, Rule>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** EngineStore in memory. `transaction` rolls back on error, like a database. */
export class MemoryStore implements EngineStore {
  state: State = { files: new Map(), plans: new Map(), audit: [], trash: new Map(), rules: new Map() };
  private ids = 0;
  /** Throw inside the next transaction, after its writes (simulates a crash before commit). */
  crashNextCommit = false;

  /** Index every file the adapter has (like a scan). */
  async indexFrom(adapter: MemoryAdapter, spaceId: Id = 1): Promise<Map<string, Id>> {
    const byPath = new Map<string, Id>();
    for (const path of adapter.paths()) {
      const e = adapter.entryAt(path);
      const id = ++this.ids;
      const dot = e.name.lastIndexOf(".");
      this.state.files.set(String(id), {
        id,
        spaceId,
        ref: e.ref,
        version: e.version,
        path: e.path,
        name: e.name,
        ext: dot > 0 ? e.name.slice(dot + 1).toLowerCase() : "",
        kind: "document",
        size: e.size,
        mtime: e.mtime,
        status: "indexed",
        flags: [],
        tags: [],
      });
      byPath.set(path, id);
    }
    return byPath;
  }
  file(id: Id) {
    return this.state.files.get(String(id))!;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const snapshot = clone(this.state);
    try {
      const result = await fn();
      if (this.crashNextCommit) {
        this.crashNextCommit = false;
        throw new Error("simulated crash");
      }
      return result;
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }
  async getFile(id: Id) {
    const f = this.state.files.get(String(id));
    return f && clone(f);
  }
  async updateFile(id: Id, patch: FilePatch) {
    const f = this.state.files.get(String(id));
    if (!f) throw new Error(`no file ${id}`);
    Object.assign(f, clone(patch));
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (f as unknown as Record<string, unknown>)[k];
  }
  async insertPlan(plan: NewPlan) {
    const id = ++this.ids;
    this.state.plans.set(String(id), { ...clone(plan), id });
    return id;
  }
  async getPlan(id: Id) {
    const p = this.state.plans.get(String(id));
    return p && clone(p);
  }
  async updatePlan(id: Id, patch: Partial<Plan>) {
    Object.assign(this.state.plans.get(String(id))!, clone(patch));
  }
  async replaceSteps(id: Id, steps: PlanStep[]) {
    this.state.plans.get(String(id))!.steps = clone(steps);
  }
  async updateStep(planId: Id, seq: number, patch: Partial<PlanStep>) {
    const step = this.state.plans.get(String(planId))!.steps.find((s) => s.seq === seq)!;
    Object.assign(step, patch);
  }
  async appendAudit(event: NewAuditEvent) {
    const id = ++this.ids;
    this.state.audit.push({ ...clone(event), id, seq: this.state.audit.length + 1 });
    return id;
  }
  async getAuditEvents(ids: Id[]) {
    const want = new Set(ids.map(String));
    return clone(this.state.audit.filter((e) => want.has(String(e.id))));
  }
  async findAudit(q: AuditQuery) {
    return clone(
      this.state.audit.filter(
        (e) =>
          (q.spaceId === undefined || String(e.spaceId) === String(q.spaceId)) &&
          (q.batchId === undefined || e.batchId === q.batchId) &&
          (q.planId === undefined || String(e.planId) === String(q.planId)) &&
          (q.actorPrefix === undefined || e.actor.startsWith(q.actorPrefix)) &&
          (q.since === undefined || e.at >= q.since),
      ),
    );
  }
  async findUndoEvents(eventIds: Id[]) {
    const want = new Set(eventIds.map(String));
    return clone(this.state.audit.filter((e) => e.undoesEventId !== undefined && want.has(String(e.undoesEventId))));
  }
  async putTrash(record: TrashRecord) {
    this.state.trash.set(String(record.fileId), clone(record));
  }
  async getTrash(fileId: Id) {
    const t = this.state.trash.get(String(fileId));
    return t && clone(t);
  }
  async clearTrash(fileId: Id) {
    this.state.trash.delete(String(fileId));
  }
  async createRule(rule: NewRule) {
    const id = ++this.ids;
    this.state.rules.set(String(id), { ...clone(rule), id });
    return id;
  }
  async getRule(id: Rule["id"]) {
    const r = this.state.rules.get(String(id));
    return r && clone(r);
  }
  async putRule(rule: Rule) {
    this.state.rules.set(String(rule.id), clone(rule));
  }
  async removeRule(id: Rule["id"]) {
    this.state.rules.delete(String(id));
  }
}
