import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ScrollText, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db, type AuditRecord } from "@/lib/db";
import { undoBatch, undoEntry } from "@/lib/actions/engine";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import { PlaceholderPage } from "@/pages/placeholder-page";

async function runUndo(p: Promise<{ undone: number; failed: number; errors: string[] }>) {
  const r = await p;
  toast(r.failed ? `Undid ${r.undone}; ${r.failed} failed: ${r.errors[0]}` : `Undid ${r.undone} change${r.undone === 1 ? "" : "s"}`, r.failed ? "error" : "success");
}

/** Append-only log: who, what, which file, old → new, when, why. Undo per entry or per batch. */
export function AuditPage() {
  const root = useActiveRoot();
  const entries = useLiveQuery(() => (root ? db.audit.where("rootId").equals(root.id).reverse().limit(1000).toArray() : []), [root?.id]);
  // A batch can only be undone once its plan has finished executing.
  const running = useLiveQuery(async () => new Set((await db.plans.where("status").equals("approved").toArray()).map((p) => p.id)), []);
  const names = useLiveQuery(async () => new Map((root ? await db.files.where("rootId").equals(root.id).toArray() : []).map((f) => [f.id, f.name])), [root?.id]);
  const batches = useMemo(() => {
    const m = new Map<string, AuditRecord[]>();
    for (const e of entries ?? []) m.set(e.batchId, [...(m.get(e.batchId) ?? []), e]);
    return [...m];
  }, [entries]);

  if (!root) return <PlaceholderPage icon={ScrollText} title="Audit Log" description="Open a folder first." />;
  if (!batches.length) return <PlaceholderPage icon={ScrollText} title="No changes yet" description="Every move, rename, tag, caption, trash and rule change is logged here, with undo." />;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-5xl space-y-3">
        <h1 className="font-semibold">Audit Log</h1>
        {batches.map(([batchId, list]) => {
          const first = list[list.length - 1]!;
          const inProgress = first.planId !== undefined && Boolean(running?.has(first.planId));
          const canUndo = !inProgress && list.some((e) => !e.undone && e.action !== "undo");
          return (
            <section key={batchId} className="rounded-lg border bg-surface">
              <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
                <span className="font-medium">{first.reason ?? first.action}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{first.actor}</span>
                <span className="text-xs text-muted">
                  {formatDate(first.at)} · {list.length} change{list.length === 1 ? "" : "s"}
                </span>
                {inProgress && <span className="ml-auto text-xs text-muted">Running…</span>}
                {canUndo && (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => void runUndo(undoBatch(batchId))}>
                    <Undo2 />
                    Undo batch
                  </Button>
                )}
              </header>
              <table className="w-full table-fixed font-mono text-xs">
                <tbody>
                  {list.slice(0, 50).map((e) => (
                    <tr key={e.id} className={cn("border-b last:border-0", e.undone && "text-muted line-through")}>
                      <td className="w-28 whitespace-nowrap px-3 py-1.5 text-muted">{new Date(e.at).toLocaleTimeString()}</td>
                      <td className="w-24 px-2 py-1.5">{e.action}</td>
                      <td className="w-48 truncate px-2 py-1.5" title={e.fileIds.map((id) => names?.get(id)).join(", ")}>
                        {e.fileIds.map((id) => names?.get(id) ?? `#${id}`).join(", ") || "—"}
                      </td>
                      <td className="truncate px-2 py-1.5 text-muted" title={`${e.before} → ${e.after}`}>
                        {e.before ?? "—"} → <span className="text-text">{e.after ?? "—"}</span>
                      </td>
                      <td className="w-20 px-2 py-1.5 text-right">
                        {!e.undone && !inProgress && e.action !== "undo" && (
                          <button className="text-accent hover:underline" onClick={() => void runUndo(undoEntry(e.id))}>
                            Undo
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {list.length > 50 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-1.5 text-muted">
                        …and {list.length - 50} more
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
    </div>
  );
}
