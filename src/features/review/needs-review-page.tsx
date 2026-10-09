import { useState } from "react";
import { Check, Inbox, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FileRecord } from "@/lib/db";
import { acceptReview, renameOne, setCategory, trashFiles, unflag } from "@/lib/actions/user-actions";
import { runAIAnalysis } from "@/lib/ai/pipeline";
import { Thumbnail } from "@/features/files/thumbnail";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { useSelection } from "@/stores/selection";
import { toast } from "@/stores/toasts";
import { PlaceholderPage } from "@/pages/placeholder-page";

function ReviewRow({ file, ids, categories }: { file: FileRecord; ids: number[]; categories: string[] }) {
  const open = useSelection((s) => s.openQuickLook);
  const [category, setCat] = useState(file.category ?? "");
  const [name, setName] = useState(file.suggestedName ?? "");
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-surface p-2">
      <button className="w-20 shrink-0" onClick={() => open(file.id, ids)} aria-label={`Preview ${file.name}`}>
        <Thumbnail file={file} accessKey={0} />
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium" title={file.path}>
          {file.name}
        </p>
        <p className="truncate text-xs text-muted">
          {file.confidence !== undefined && <span className="text-warning">{Math.round(file.confidence * 100)}% sure · </span>}
          {file.caption || file.aiReason || "No description"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Input value={category} onChange={(e) => setCat(e.target.value)} list="fp-review-categories" placeholder="Category" className="h-8 w-40 text-xs" aria-label="Category" />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Better name (optional)" className="h-8 min-w-48 flex-1 text-xs" aria-label="New name" />
        </div>
      </div>
      <Button
        size="sm"
        onClick={async () => {
          if (category && category !== file.category) await setCategory(file.rootId, [file], category);
          else await acceptReview([file]);
          if (name.trim() && name.trim() !== file.name) await renameOne(file.rootId, file, name);
        }}
      >
        <Check />
        Accept
      </Button>
      <datalist id="fp-review-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}

function DeleteRow({ file, ids }: { file: FileRecord; ids: number[] }) {
  const open = useSelection((s) => s.openQuickLook);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-surface p-2">
      <button className="w-20 shrink-0" onClick={() => open(file.id, ids)} aria-label={`Preview ${file.name}`}>
        <Thumbnail file={file} accessKey={0} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="truncate font-mono text-xs text-muted">{file.path}</p>
        <p className="text-xs text-danger">Why: {file.flagReason ?? "suggested for deletion"}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void unflag(file.rootId, [file], "suggested_delete")}>
        Keep
      </Button>
      <Button size="sm" variant="destructive" onClick={() => void trashFiles(file.rootId, [file], file.flagReason)}>
        <Trash2 />
        Trash
      </Button>
    </div>
  );
}

export function NeedsReviewPage() {
  const root = useActiveRoot();
  const files = useRootFiles(root?.id) ?? [];
  if (!root) return <PlaceholderPage icon={Inbox} title="Needs Review" description="Open a folder first." />;
  const lowConfidence = files.filter((f) => f.status === "needs_review");
  const deletions = files.filter((f) => f.flags.includes("suggested_delete") && f.status !== "trashed");
  const categories = [...new Set(files.map((f) => f.category).filter((c): c is string => Boolean(c)))].sort();

  if (!lowConfidence.length && !deletions.length)
    return <PlaceholderPage icon={Inbox} title="Nothing to review" description="Files the AI wasn't sure about, and files suggested for deletion, show up here for you to decide." />;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-4xl space-y-8">
        {deletions.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Suggested for deletion</h2>
              <span className="text-xs text-muted">{deletions.length} · you decide; trashing is reversible</span>
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void unflag(root.id, deletions, "suggested_delete")}>
                Keep all
              </Button>
            </div>
            {deletions.map((f) => (
              <DeleteRow key={f.id} file={f} ids={deletions.map((d) => d.id)} />
            ))}
          </section>
        )}
        {lowConfidence.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">AI wasn't sure</h2>
              <span className="text-xs text-muted">{lowConfidence.length} · confirm or correct the category</span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() =>
                  void runAIAnalysis(root.id, lowConfidence.map((f) => f.id))
                    .then((r) => toast(`Re-analyzed: ${r.analyzed} confident, ${r.review} still unsure`))
                    .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"))
                }
              >
                <Sparkles />
                Re-analyze
              </Button>
              <Button size="sm" onClick={() => void acceptReview(lowConfidence)}>
                <Check />
                Accept all
              </Button>
            </div>
            {lowConfidence.map((f) => (
              <ReviewRow key={f.id} file={f} ids={lowConfidence.map((d) => d.id)} categories={categories} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
