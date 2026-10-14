import { useMemo, useState, type DragEvent } from "react";
import { ArrowLeft, FolderInput, Shapes } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { db, type FileRecord } from "@/lib/db";
import { getDragFiles, hasDragFiles } from "@/lib/dnd";
import { setCategory } from "@/lib/actions/user-actions";
import { proposeFolders } from "@/lib/actions/organize";
import { formatBytes } from "@/lib/format";
import { cn } from "@folderpilot/ui";
import { FileBrowser } from "@/features/files/file-browser";
import { PlanDialog } from "@/features/plans/plan-card";
import { RuleBuilderDialog } from "@/features/rules/rule-builder";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import type { NewRule } from "@folderpilot/core";
import { PlaceholderPage } from "@/pages/placeholder-page";

/** Rule draft offered after dragging a file onto a category: "files like this → that category". */
function ruleFromExample(file: FileRecord, category: string): NewRule {
  const words = file.name.replace(/\.[^.]+$/, "").split(/[\s_\-()]+/).filter((w) => w.length > 3 && !/^\d+$/.test(w));
  const conditions: NewRule["conditions"] = [{ field: "ext", op: "is", value: file.ext }];
  if (words[0]) conditions.push({ field: "name", op: "contains", value: words[0].toLowerCase() });
  return { type: "structured", name: `${words[0] ?? file.ext.toUpperCase()} → ${category}`, enabled: true, priority: 99, match: "all", conditions, actions: [{ type: "set_category", value: category }], createdBy: "user", createdAt: Date.now() };
}

/** Group key for files without a category (data value, shown translated). */
const UNCATEGORIZED = "Uncategorized";

export function CategoriesPage() {
  const { t } = useTranslation("categories");
  const root = useActiveRoot();
  const files = useRootFiles(root?.id);
  const [open, setOpen] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<NewRule | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, FileRecord[]>();
    for (const f of files ?? []) {
      if (f.status === "trashed") continue;
      const key = f.category ?? UNCATEGORIZED;
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m].sort((a, b) => (a[0] === UNCATEGORIZED ? 1 : b[0] === UNCATEGORIZED ? -1 : b[1].length - a[1].length));
  }, [files]);

  if (!root) return <PlaceholderPage icon={Shapes} title={t("title")} description={t("noFolder")} />;
  if (!groups.some(([c]) => c !== UNCATEGORIZED))
    return <PlaceholderPage icon={Shapes} title={t("emptyTitle")} description={t("emptyDescription")} />;

  const onDrop = async (e: DragEvent, category: string) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    setDropTarget(null);
    if (category === UNCATEGORIZED) return;
    const ids = getDragFiles(e);
    const dropped = (await db.files.bulkGet(ids)).filter((f): f is FileRecord => Boolean(f));
    const res = await setCategory(root.id, dropped, category);
    const example = dropped[0];
    if (res && example) toast(t("movedTo", { category }), "success", { label: t("makeRule"), run: () => setRuleDraft(ruleFromExample(example, category)) });
  };

  const current = open ? groups.find(([c]) => c === open)?.[1] ?? [] : null;
  const label = (c: string) => (c === UNCATEGORIZED ? t("uncategorized") : c);

  return (
    <div className="flex h-full flex-col">
      {current ? (
        <>
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(null)} aria-label={t("backToCategories")}>
              <ArrowLeft />
            </Button>
            <div>
              <h1 className="font-semibold">{open && label(open)}</h1>
              <p className="text-xs text-muted">{t("detailHint", { count: current.length })}</p>
            </div>
            {open !== UNCATEGORIZED && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={async () => {
                  const id = await proposeFolders(root.id, current, "{category}");
                  if (id) setPlanId(id);
                  else toast(t("alreadyOrganized"));
                }}
              >
                <FolderInput />
                {t("moveIntoFolder", { category: open })}
              </Button>
            )}
          </div>
          <div className="flex min-h-0 flex-1">
            <nav className="w-52 shrink-0 overflow-y-auto border-r p-2" aria-label={t("dropTargets")}>
              {groups.map(([c, list]) => (
                <div
                  key={c}
                  onDragOver={(e) => {
                    if (!hasDragFiles(e)) return;
                    e.preventDefault();
                    setDropTarget(c);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => void onDrop(e, c)}
                  onClick={() => setOpen(c)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm",
                    c === open ? "bg-accent-soft text-accent" : "hover:bg-surface-2",
                    dropTarget === c && "ring-2 ring-accent",
                  )}
                >
                  <span className="truncate">{label(c)}</span>
                  <span className="text-xs text-muted">{list.length}</span>
                </div>
              ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              <FileBrowser rootId={root.id} files={current} allFiles={files} accessKey={0} />
            </div>
          </div>
        </>
      ) : (
        <div className="overflow-y-auto p-4">
          <h1 className="mb-1 font-semibold">{t("title")}</h1>
          <p className="mb-4 text-xs text-muted">{t("intro")}</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {groups.map(([c, list]) => (
              <button
                key={c}
                onClick={() => setOpen(c)}
                onDragOver={(e) => {
                  if (!hasDragFiles(e)) return;
                  e.preventDefault();
                  setDropTarget(c);
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => void onDrop(e, c)}
                className={cn("rounded-lg border bg-surface p-4 text-left transition-colors hover:bg-surface-2", dropTarget === c && "border-accent bg-accent-soft")}
              >
                <p className="font-medium">{label(c)}</p>
                <p className="text-xs text-muted">
                  {t("summary", { count: list.length, size: formatBytes(list.reduce((s, f) => s + f.size, 0)) })}
                </p>
                <p className="mt-2 truncate text-xs text-muted">{[...new Set(list.flatMap((f) => f.tags))].slice(0, 4).join(", ")}</p>
              </button>
            ))}
          </div>
        </div>
      )}
      {ruleDraft && <RuleBuilderDialog initial={ruleDraft} onClose={() => setRuleDraft(null)} />}
      <PlanDialog planId={planId} onClose={() => setPlanId(null)} />
    </div>
  );
}
