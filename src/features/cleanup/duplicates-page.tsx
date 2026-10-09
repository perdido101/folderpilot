import { useMemo, useState } from "react";
import { Copy, Minimize2, Monitor, Moon, PlayCircle, Trash2, Waves, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileFlag, FileRecord } from "@/lib/db";
import { exactGroups, nearGroups, type DuplicateGroup } from "@/lib/analysis/duplicates";
import { trashFiles } from "@/lib/actions/user-actions";
import { formatBytes } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Thumbnail } from "@/features/files/thumbnail";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { useAnalysis } from "@/stores/analysis";
import { useSelection } from "@/stores/selection";
import { PlaceholderPage } from "@/pages/placeholder-page";
import { ReviewMode, type ReviewItem } from "./review-mode";

type Tab = "exact" | "near" | "blurry" | "dark" | "tiny" | "screenshot";
const FLAG_TABS: { key: Exclude<Tab, "exact" | "near">; label: string; icon: LucideIcon; reason: string }[] = [
  { key: "blurry", label: "Blurry", icon: Waves, reason: "Looks blurry" },
  { key: "dark", label: "Dark", icon: Moon, reason: "Very dark" },
  { key: "tiny", label: "Tiny", icon: Minimize2, reason: "Very small image" },
  { key: "screenshot", label: "Screenshots", icon: Monitor, reason: "Screenshot" },
];

function Tile({ file, badge, ids }: { file: FileRecord; badge?: string; ids: number[] }) {
  const open = useSelection((s) => s.openQuickLook);
  return (
    <button onClick={() => open(file.id, ids)} className="group relative w-36 shrink-0 rounded-lg border bg-surface p-1.5 text-left hover:bg-surface-2" title={file.path}>
      <Thumbnail file={file} accessKey={0} />
      <p className="mt-1 truncate text-xs font-medium">{file.name}</p>
      <p className="truncate font-mono text-[10px] text-muted">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "/"}</p>
      {badge && <span className="absolute left-2.5 top-2.5 rounded bg-success px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">{badge}</span>}
    </button>
  );
}

function GroupCard({ group, rootId }: { group: DuplicateGroup; rootId: number }) {
  const ids = [group.keep.id, ...group.others.map((f) => f.id)];
  const saved = group.kind === "exact" ? group.others.reduce((s, f) => s + f.size, 0) : 0;
  return (
    <div className="rounded-lg border bg-surface">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="font-medium">{group.others.length + 1} copies</span>
        {saved > 0 && <span className="text-xs text-muted">· {formatBytes(saved)} reclaimable</span>}
        <Button size="sm" variant="ghost" className="ml-auto text-danger hover:bg-danger/10" onClick={() => void trashFiles(rootId, group.others, `${group.kind === "exact" ? "Exact" : "Near"} duplicates of ${group.keep.name}`)}>
          <Trash2 />
          Trash {group.others.length} {group.others.length === 1 ? "copy" : "copies"}
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto p-3">
        <Tile file={group.keep} badge="Keep best" ids={ids} />
        {group.others.map((f) => (
          <Tile key={f.id} file={f} ids={ids} />
        ))}
      </div>
    </div>
  );
}

export function DuplicatesPage() {
  const root = useActiveRoot();
  const files = useRootFiles(root?.id);
  const { thresholds } = useSettings();
  const phase = useAnalysis((s) => s.phase);
  const [tab, setTab] = useState<Tab>("exact");
  const [review, setReview] = useState<{ title: string; items: ReviewItem[] } | null>(null);

  const data = useMemo(() => {
    const list = files ?? [];
    const exact = exactGroups(list);
    const near = nearGroups(list, thresholds.nearDuplicateDistance);
    const flagged = (flag: FileFlag) => list.filter((f) => f.status !== "trashed" && f.flags.includes(flag));
    return { exact, near, blurry: flagged("blurry"), dark: flagged("dark"), tiny: flagged("tiny"), screenshot: flagged("screenshot"), analyzed: list.filter((f) => f.analyzedLocally).length, total: list.length };
  }, [files, thresholds.nearDuplicateDistance]);

  if (!root) return <PlaceholderPage icon={Copy} title="Duplicates & Bad Files" description="Open a folder first. Duplicates, blurry, dark and tiny photos show up here." />;

  const tabs: { key: Tab; label: string; icon: LucideIcon; count: number }[] = [
    { key: "exact", label: "Exact duplicates", icon: Copy, count: data.exact.reduce((s, g) => s + g.others.length, 0) },
    { key: "near", label: "Near-duplicates", icon: Copy, count: data.near.reduce((s, g) => s + g.others.length, 0) },
    ...FLAG_TABS.map((t) => ({ key: t.key as Tab, label: t.label, icon: t.icon, count: data[t.key].length })),
  ];
  const groups = tab === "exact" ? data.exact : tab === "near" ? data.near : null;
  const flagged = tab === "exact" || tab === "near" ? [] : data[tab];
  const reclaim = data.exact.flatMap((g) => g.others).reduce((s, f) => s + f.size, 0);

  const startReview = () => {
    if (groups) {
      setReview({ title: tab === "exact" ? "Exact duplicates" : "Near-duplicates", items: groups.flatMap((g) => g.others.map((f) => ({ file: f, keep: g.keep, reason: tab === "exact" ? "Identical content" : "Looks almost the same" }))) });
    } else {
      const t = FLAG_TABS.find((x) => x.key === tab)!;
      setReview({ title: t.label, items: flagged.map((f) => ({ file: f, reason: t.reason })) });
    }
  };
  const reviewCount = groups ? groups.reduce((s, g) => s + g.others.length, 0) : flagged.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div>
          <h1 className="font-semibold">Duplicates & Bad Files</h1>
          <p className="text-xs text-muted">
            {phase === "local" ? "Analyzing…" : `${data.analyzed} of ${data.total} files analyzed locally`} · {formatBytes(reclaim)} in exact copies
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {groups && groups.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="text-danger"
              onClick={() => void trashFiles(root.id, groups.flatMap((g) => g.others), `All ${tab === "exact" ? "exact" : "near"} duplicates (kept best copy)`)}
            >
              <Trash2 />
              Trash all copies, keep best
            </Button>
          )}
          <Button size="sm" onClick={startReview} disabled={reviewCount === 0}>
            <PlayCircle />
            Review one by one ({reviewCount})
          </Button>
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b px-4 py-1.5" role="tablist">
        {tabs.map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors", tab === key ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}
          >
            <Icon className="size-3.5" />
            {label}
            <span className="tabular-nums opacity-70">{count}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {groups ? (
          groups.length === 0 ? (
            <p className="p-8 text-center text-muted">{data.analyzed < data.total ? "Still analyzing — duplicates appear as files are hashed." : "No duplicates found. Nice and tidy."}</p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <GroupCard key={g.keep.id} group={g} rootId={root.id} />
              ))}
            </div>
          )
        ) : flagged.length === 0 ? (
          <p className="p-8 text-center text-muted">Nothing here.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {flagged.map((f) => (
              <Tile key={f.id} file={f} ids={flagged.map((x) => x.id)} />
            ))}
          </div>
        )}
      </div>
      {review && <ReviewMode rootId={root.id} title={review.title} items={review.items} onClose={() => setReview(null)} />}
    </div>
  );
}
