import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import { Bot, ScrollText, Undo2 } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@folderpilot/ui";
import i18n from "@/i18n";
import { db, type AuditRecord } from "@/lib/db";
import { undoAgentSince, undoBatch, undoEntry } from "@/lib/actions/engine";
import { undoneIds } from "@/lib/actions/undone";
import { formatDate } from "@/lib/format";
import { cn } from "@folderpilot/ui";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import { PlaceholderPage } from "@/pages/placeholder-page";

async function runUndo(p: Promise<{ undone: number; failed: number; errors: string[] }>) {
  const r = await p;
  if (r.undone === 0 && r.failed === 0) {
    toast(i18n.t("audit:nothingToUndo"));
    return;
  }
  toast(
    r.failed ? i18n.t("audit:undidWithFailures", { undone: r.undone, failed: r.failed, error: r.errors[0] }) : i18n.t("audit:undid", { count: r.undone }),
    r.failed ? "error" : "success",
  );
}

/** Append-only log: who, what, which file, old → new, when, why. Undo per entry or per batch. */
export function AuditPage() {
  const root = useActiveRoot();
  const { t, i18n: inst } = useTranslation(["audit", "common"]);
  const entries = useLiveQuery(() => (root ? db.audit.where("rootId").equals(root.id).reverse().limit(1000).toArray() : []), [root?.id]);
  // A batch can only be undone once its plan has finished executing.
  const running = useLiveQuery(async () => new Set((await db.plans.where("status").anyOf("approved", "executing").toArray()).map((p) => p.id)), []);
  const undone = useMemo(() => undoneIds(entries ?? []), [entries]);
  const names = useLiveQuery(
    async () => new Map((root ? await db.files.where("rootId").equals(root.id).toArray() : []).map((f) => [f.id, f.name])),
    [root?.id],
  );
  const batches = useMemo(() => {
    const m = new Map<string, AuditRecord[]>();
    for (const e of entries ?? []) m.set(e.batchId, [...(m.get(e.batchId) ?? []), e]);
    return [...m];
  }, [entries]);

  if (!root) return <PlaceholderPage icon={ScrollText} title={t("title")} description={t("openFolder")} />;
  if (!batches.length) return <PlaceholderPage icon={ScrollText} title={t("emptyTitle")} description={t("emptyDescription")} />;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-5xl space-y-3">
        <div className="flex items-center gap-2">
          <h1 className="font-semibold">{t("title")}</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="ml-auto">
                <Bot />
                {t("undoAgent.label")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(
                [
                  ["hour", 3_600_000],
                  ["day", 86_400_000],
                  ["week", 7 * 86_400_000],
                ] as const
              ).map(([key, ms]) => (
                <DropdownMenuItem key={key} onSelect={() => void runUndo(undoAgentSince(root.id, Date.now() - ms))}>
                  {t(`undoAgent.${key}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {batches.map(([batchId, list]) => {
          const first = list[list.length - 1]!;
          const inProgress = first.planId !== undefined && Boolean(running?.has(first.planId));
          const canUndo = !inProgress && list.some((e) => !undone.has(e.id) && e.action !== "undo");
          return (
            <section key={batchId} className="rounded-lg border bg-surface">
              <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
                <span className="font-medium">{first.reason ?? first.action}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{first.actor}</span>
                <span className="text-xs text-muted">
                  {formatDate(first.at)} · {t("changes", { count: list.length })}
                </span>
                {inProgress && <span className="ml-auto text-xs text-muted">{t("running")}</span>}
                {canUndo && (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => void runUndo(undoBatch(batchId))}>
                    <Undo2 />
                    {t("undoBatch")}
                  </Button>
                )}
              </header>
              <table className="w-full table-fixed font-mono text-xs">
                <tbody>
                  {list.slice(0, 50).map((e) => (
                    <tr key={e.id} className={cn("border-b last:border-0", undone.has(e.id) && "text-muted line-through")}>
                      <td className="w-28 whitespace-nowrap px-3 py-1.5 text-muted">{new Date(e.at).toLocaleTimeString(inst.language)}</td>
                      <td className="w-24 px-2 py-1.5">{e.action}</td>
                      <td className="w-48 truncate px-2 py-1.5" title={e.fileIds.map((id) => names?.get(id)).join(", ")}>
                        {e.fileIds.map((id) => names?.get(id) ?? `#${id}`).join(", ") || "—"}
                      </td>
                      <td className="truncate px-2 py-1.5 text-muted" title={`${e.before} → ${e.after}`}>
                        {e.before ?? "—"} → <span className="text-text">{e.after ?? "—"}</span>
                      </td>
                      <td className="w-20 px-2 py-1.5 text-right">
                        {!undone.has(e.id) && !inProgress && e.action !== "undo" && (
                          <button className="text-accent hover:underline" onClick={() => void runUndo(undoEntry(e.id))}>
                            {t("common:actions.undo")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {list.length > 50 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-1.5 text-muted">
                        {t("more", { count: list.length - 50 })}
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
