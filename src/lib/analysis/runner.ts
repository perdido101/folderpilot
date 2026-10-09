import { db, type FileRecord } from "../db";
import { getFile } from "../file-access-cache";
import { getSettings } from "../settings";
import { useAnalysis } from "@/stores/analysis";
import type { AnalyzeRequest, AnalyzeResult } from "@/workers/analysis.worker";
import { computeFlags } from "./duplicates";

const POOL = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
let running: Promise<void> | null = null;

class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, (r: AnalyzeResult) => void>();
  private next = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("../../workers/analysis.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<AnalyzeResult>) => {
        this.pending.get(e.data.id)?.(e.data);
        this.pending.delete(e.data.id);
      };
      this.workers.push(w);
    }
  }
  run(req: AnalyzeRequest): Promise<AnalyzeResult> {
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve);
      this.workers[this.next++ % this.workers.length]!.postMessage(req);
    });
  }
  close() {
    this.workers.forEach((w) => w.terminate());
  }
}

/** Recompute duplicate/quality flags for a root from stored metrics (also after threshold changes). */
export async function recomputeFlags(rootId: number) {
  const settings = await getSettings();
  const files = await db.files.where("rootId").equals(rootId).toArray();
  const flags = computeFlags(files, settings.thresholds);
  const changed = files.filter((f) => {
    const next = flags.get(f.id);
    return next && next.join() !== f.flags.join();
  });
  await db.transaction("rw", db.files, async () => {
    for (const f of changed) await db.files.update(f.id, { flags: flags.get(f.id)! });
  });
}

async function analyzeOne(pool: WorkerPool, f: FileRecord): Promise<Partial<FileRecord> | null> {
  const blob = await getFile(f);
  if (!blob) return null; // no access right now; try again later
  const r = await pool.run({ id: f.id, file: blob, ext: f.ext, kind: f.kind });
  const patch: Partial<FileRecord> = { analyzedLocally: true };
  for (const key of ["sha256", "dhash", "blurScore", "brightness", "width", "height", "exif", "textExcerpt"] as const) {
    if (r[key] !== undefined) Object.assign(patch, { [key]: r[key] });
  }
  if (f.ext === "pdf") {
    // pdf.js is large; load it only when a PDF shows up.
    const { pdfText } = await import("./pdf-text");
    patch.textExcerpt = await pdfText(blob).catch(() => undefined);
  }
  return patch;
}

/** Analyze every not-yet-analyzed file of a root with a pool of workers. Free, local, no AI. */
export function runLocalAnalysis(rootId: number): Promise<void> {
  if (running) return running;
  running = (async () => {
    const store = useAnalysis.getState();
    const todo = (await db.files.where("rootId").equals(rootId).toArray()).filter((f) => !f.analyzedLocally && f.status !== "trashed");
    store.set({ phase: "local", done: 0, total: todo.length, lastError: null });
    const pool = new WorkerPool(POOL);
    let done = 0;
    // Write results in batches: every write re-runs live queries and re-renders the file grid.
    let pending: { key: number; changes: Partial<FileRecord> }[] = [];
    let lastFlush = performance.now();
    const flush = async () => {
      const batch = pending;
      pending = [];
      lastFlush = performance.now();
      if (batch.length) await db.files.bulkUpdate(batch);
      useAnalysis.getState().set({ done });
    };
    try {
      let cursor = 0;
      const lane = async () => {
        while (cursor < todo.length) {
          const f = todo[cursor++]!;
          try {
            const patch = await analyzeOne(pool, f);
            if (patch) pending.push({ key: f.id, changes: patch });
          } catch (err) {
            store.set({ lastError: err instanceof Error ? err.message : String(err) });
          }
          done++;
          if (pending.length >= 50 || performance.now() - lastFlush > 1500) await flush();
        }
      };
      await Promise.all(Array.from({ length: POOL * 2 }, lane));
      await flush();
      await recomputeFlags(rootId);
    } finally {
      pool.close();
      useAnalysis.getState().set({ phase: "idle" });
      running = null;
    }
  })();
  return running;
}
