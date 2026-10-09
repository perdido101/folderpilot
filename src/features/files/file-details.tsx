import { useState, type ReactNode } from "react";
import { Plus, Sparkles, X } from "lucide-react";
import type { FileRecord } from "@/lib/db";
import { renameOne, setCaption, setCategory, tagFiles, untagFile } from "@/lib/actions/user-actions";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Click-to-edit text. Commits on Enter/blur, cancels on Escape. */
function InlineEdit({ value, onCommit, placeholder, mono, multiline }: { value: string; onCommit: (v: string) => void; placeholder: string; mono?: boolean; multiline?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  if (!editing)
    return (
      <button
        className={cn("w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2", mono && "font-mono text-xs", !value && "text-muted")}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title="Click to edit"
      >
        {value || placeholder}
      </button>
    );
  const props = {
    autoFocus: true,
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation(); // keep Space/arrows away from quick-look
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(false);
      }
    },
    className: cn("w-full rounded-md border bg-surface px-1.5 py-1 text-sm", mono && "font-mono text-xs"),
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="px-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}

const FLAG_LABEL: Record<string, string> = {
  duplicate: "Exact duplicate",
  near_duplicate: "Near-duplicate",
  blurry: "Blurry",
  dark: "Dark",
  tiny: "Tiny",
  screenshot: "Screenshot",
  suggested_delete: "Suggested for deletion",
};

/** Inline editing of name, category, caption and tags. Every edit goes through the action engine. */
export function FileDetails({ file }: { file: FileRecord }) {
  const [newTag, setNewTag] = useState("");
  const readonly = file.status === "trashed";

  return (
    <div className="space-y-3 text-sm">
      <Row label="Name">{readonly ? <p className="px-1.5">{file.name}</p> : <InlineEdit value={file.name} placeholder="Name" onCommit={(v) => void renameOne(file.rootId, file, v)} />}</Row>
      {file.suggestedName && !readonly && (
        <button className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-accent hover:bg-accent-soft" onClick={() => void renameOne(file.rootId, file, file.suggestedName!)}>
          <Sparkles className="size-3.5 shrink-0" />
          <span className="truncate">Use suggested: {file.suggestedName}</span>
        </button>
      )}
      <Row label="Category">
        <InlineEdit value={file.category ?? ""} placeholder="Not categorized" onCommit={(v) => v && void setCategory(file.rootId, [file], v)} />
      </Row>
      <Row label="Caption">
        <InlineEdit value={file.caption ?? ""} placeholder="Add a caption" multiline onCommit={(v) => void setCaption(file.rootId, file, v)} />
      </Row>
      <Row label="Tags">
        <div className="flex flex-wrap gap-1 px-1.5">
          {file.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs">
              {t}
              <button onClick={() => void untagFile(file.rootId, file, t)} aria-label={`Remove tag ${t}`} className="text-muted hover:text-text">
                <X className="size-3" />
              </button>
            </span>
          ))}
          <form
            className="inline-flex items-center"
            onSubmit={(e) => {
              e.preventDefault();
              if (newTag.trim()) void tagFiles(file.rootId, [file], newTag);
              setNewTag("");
            }}
          >
            <Plus className="size-3 text-muted" />
            <input value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="tag" className="w-16 bg-transparent px-1 text-xs outline-none" aria-label="Add tag" />
          </form>
        </div>
      </Row>
      {file.flags.length > 0 && (
        <Row label="Flags">
          <div className="flex flex-wrap gap-1 px-1.5">
            {file.flags.map((f) => (
              <span key={f} className={cn("rounded-full px-2 py-0.5 text-xs", f === "suggested_delete" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning")}>
                {FLAG_LABEL[f] ?? f}
              </span>
            ))}
          </div>
          {file.flagReason && <p className="px-1.5 text-xs text-muted">“{file.flagReason}”</p>}
        </Row>
      )}
      {file.confidence !== undefined && (
        <Row label="AI">
          <p className="px-1.5 text-xs text-muted">
            {Math.round(file.confidence * 100)}% confident{file.client ? ` · client: ${file.client}` : ""}
            {file.aiReason ? ` · ${file.aiReason}` : ""}
          </p>
        </Row>
      )}
      <Row label="Details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-1.5 text-xs text-muted">
          <dt>Size</dt>
          <dd>{formatBytes(file.size)}</dd>
          <dt>Modified</dt>
          <dd>{formatDate(file.mtime)}</dd>
          {file.width && (
            <>
              <dt>Pixels</dt>
              <dd>
                {file.width}×{file.height}
              </dd>
            </>
          )}
          {file.exif?.Model && (
            <>
              <dt>Camera</dt>
              <dd>
                {String(file.exif.Make ?? "")} {String(file.exif.Model)}
              </dd>
            </>
          )}
          {file.sha256 && (
            <>
              <dt>SHA-256</dt>
              <dd className="truncate font-mono" title={file.sha256}>
                {file.sha256.slice(0, 16)}…
              </dd>
            </>
          )}
        </dl>
      </Row>
    </div>
  );
}
