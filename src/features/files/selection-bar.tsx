import { useState } from "react";
import { Bot, FolderInput, PenLine, Sparkles, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PromptDialog } from "@/components/prompt-dialog";
import type { FileRecord } from "@/lib/db";
import { moveFiles, renameFiles, renameSteps, tagFiles, trashFiles } from "@/lib/actions/user-actions";
import { useChat } from "@/stores/chat";
import { useUI } from "@/stores/ui";

type DialogKind = "move" | "tag" | "rename" | null;

/** Floating action bar for the current selection. Every action runs through the engine with an Undo toast. */
export function SelectionBar({ rootId, files, allFiles, onClear }: { rootId: number; files: FileRecord[]; allFiles: FileRecord[]; onClear: () => void }) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const attach = useChat((s) => s.attach);
  const agentOpen = useUI((s) => s.agentPanelOpen);
  const toggleAgent = useUI((s) => s.toggleAgentPanel);
  if (files.length === 0) return null;
  const folders = [...new Set(allFiles.map((f) => (f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "")).filter((f) => f && !f.startsWith(".")))].sort();
  const withSuggestions = files.filter((f) => f.suggestedName);
  const live = files.filter((f) => f.status !== "trashed");

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border bg-surface p-1.5 shadow-sm animate-in fade-in-0 slide-in-from-bottom-2">
          <span className="px-3 text-sm font-medium tabular-nums">{files.length.toLocaleString()} selected</span>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={() => setDialog("move")} disabled={!live.length}>
            <FolderInput />
            Move
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDialog("tag")} disabled={!live.length}>
            <Tag />
            Tag
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDialog("rename")} disabled={!live.length}>
            <PenLine />
            Rename
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              attach(files.map((f) => f.id));
              if (!agentOpen) toggleAgent();
              setTimeout(() => document.getElementById("agent-input")?.focus(), 50);
            }}
          >
            <Bot />
            Ask agent
          </Button>
          <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10" onClick={() => void trashFiles(rootId, live).then(onClear)} disabled={!live.length}>
            <Trash2 />
            Trash
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)">
            <X />
          </Button>
        </div>
      </div>

      <PromptDialog
        open={dialog === "move"}
        title={`Move ${live.length} file${live.length === 1 ? "" : "s"}`}
        description="Folder inside this root. It's created if needed. Variables: {year} {month} {category} {client} {type}."
        label="Destination folder"
        placeholder="Clients/{client}/{year}"
        suggestions={folders}
        confirm="Move"
        onSubmit={(v) => void moveFiles(rootId, live, v)}
        onClose={() => setDialog(null)}
      />
      <PromptDialog
        open={dialog === "tag"}
        title={`Tag ${live.length} file${live.length === 1 ? "" : "s"}`}
        label="Tag"
        placeholder="paid"
        confirm="Add tag"
        onSubmit={(v) => void tagFiles(rootId, live, v)}
        onClose={() => setDialog(null)}
      />
      <PromptDialog
        open={dialog === "rename"}
        title={`Rename ${live.length} file${live.length === 1 ? "" : "s"}`}
        description="Pattern variables: {name} {n} (counter) {date} {year} {month} {category} {client}. The extension is kept."
        label="Pattern"
        initial="{date} {name}"
        confirm="Rename"
        extra={
          withSuggestions.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void renameFiles(rootId, withSuggestions, "ai");
                setDialog(null);
              }}
            >
              <Sparkles />
              Use AI-suggested names ({withSuggestions.length})
            </Button>
          )
        }
        preview={(pattern) => (
          <ul className="space-y-0.5 font-mono text-[11px]">
            {renameSteps(live.slice(0, 8), pattern || "{name}").map((s) => (
              <li key={s.fileId} className="truncate">
                <span className="text-muted">{s.before}</span> → {s.after}
              </li>
            ))}
          </ul>
        )}
        onSubmit={(v) => void renameFiles(rootId, live, v)}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
