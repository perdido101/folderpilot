import { useMemo, useState, type DragEvent } from "react";
import { ArrowLeft, FolderInput, Shapes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db, type FileRecord } from "@/lib/db";
import { getDragFiles, hasDragFiles } from "@/lib/dnd";
import { setCategory } from "@/lib/actions/user-actions";
import { proposeFolders } from "@/lib/actions/organize";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FileBrowser } from "@/features/files/file-browser";
import { PlanDialog } from "@/features/plans/plan-card";
import { RuleBuilderDialog } from "@/features/rules/rule-builder";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import type { NewRule } from "@/lib/rules/types";
import { PlaceholderPage } from "@/pages/placeholder-page";

/** Rule draft offered after dragging a file onto a category: "files like this → that category". */
function ruleFromExample(file: FileRecord, category: string): NewRule {
  const words = file.name.replace(/\.[^.]+$/, "").split(/[\s_\-()]+/).filter((w) => w.length > 3 && !/^\d+$/.test(w));
  const conditions: NewRule["conditions"] = [{ field: "ext", op: "is", value: file.ext }];
  if (words[0]) conditions.push({ field: "name", op: "contains", value: words[0].toLowerCase() });
  return { type: "structured", name: `${words[0] ?? file.ext.toUpperCase()} → ${category}`, enabled: true, priority: 99, match: "all", conditions, actions: [{ type: "set_category", value: category }], createdBy: "user", createdAt: Date.now() };
}

export function CategoriesPage() {
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
      const key = f.category ?? "Uncategorized";
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m].sort((a, b) => (a[0] === "Uncategorized" ? 1 : b[0] === "Uncategorized" ? -1 : b[1].length - a[1].length));
  }, [files]);

  if (!root) return <PlaceholderPage icon={Shapes} title="Categories" description="Open a folder first." />;
  if (!groups.some(([c]) => c !== "Uncategorized"))
    return <PlaceholderPage icon={Shapes} title="No categories yet" description="Run “Analyze with AI” on All Files to sort files into categories like Invoices, Contracts and Photos." />;

  const onDrop = async (e: DragEvent, category: string) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    setDropTarget(null);
    if (category === "Uncategorized") return;
    const ids = getDragFiles(e);
    const dropped = (await db.files.bulkGet(ids)).filter((f): f is FileRecord => Boolean(f));
    const res = await setCategory(root.id, dropped, category);
    const example = dropped[0];
    if (res && example) toast(`Moved to “${category}”`, "success", { label: "Make this a rule?", run: () => setRuleDraft(ruleFromExample(example, category)) });
  };

  const current = open ? groups.find(([c]) => c === open)?.[1] ?? [] : null;

  return (
    <div className="flex h-full flex-col">
      {current ? (
        <>
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(null)} aria-label="Back to categories">
              <ArrowLeft />
            </Button>
            <div>
              <h1 className="font-semibold">{open}</h1>
              <p className="text-xs text-muted">{current.length} files · drag files onto another category in the list to re-categorize</p>
            </div>
            {open !== "Uncategorized" && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={async () => {
                  const id = await proposeFolders(root.id, current, "{category}");
                  if (id) setPlanId(id);
                  else toast("Already organized.");
                }}
              >
                <FolderInput />
                Move into “{open}” folder…
              </Button>
            )}
          </div>
          <div className="flex min-h-0 flex-1">
            <nav className="w-52 shrink-0 overflow-y-auto border-r p-2" aria-label="Drop targets">
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
                  <span className="truncate">{c}</span>
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
          <h1 className="mb-1 font-semibold">Categories</h1>
          <p className="mb-4 text-xs text-muted">Drag files from All Files onto a category to re-categorize them.</p>
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
                <p className="font-medium">{c}</p>
                <p className="text-xs text-muted">
                  {list.length} files · {formatBytes(list.reduce((s, f) => s + f.size, 0))}
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
