import { useState } from "react";
import { Bot, FolderInput, PenLine, Sparkles, Tag, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { PromptDialog } from "@/components/prompt-dialog";
import type { FileRecord } from "@/lib/db";
import { moveFiles, renameFiles, renameSteps, tagFiles, trashFiles } from "@/lib/actions/user-actions";
import { useChat } from "@/stores/chat";
import { useUI } from "@/stores/ui";

type DialogKind = "move" | "tag" | "rename" | null;

/** Floating action bar for the current selection. Every action runs through the engine with an Undo toast. */
export function SelectionBar({ rootId, files, allFiles, onClear }: { rootId: number; files: FileRecord[]; allFiles: FileRecord[]; onClear: () => void }) {
  const { t } = useTranslation("files");
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
          <span className="px-3 text-sm font-medium tabular-nums">{t("selection.selected", { count: files.length })}</span>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={() => setDialog("move")} disabled={!live.length}>
            <FolderInput />
            {t("selection.move")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDialog("tag")} disabled={!live.length}>
            <Tag />
            {t("selection.tag")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDialog("rename")} disabled={!live.length}>
            <PenLine />
            {t("selection.rename")}
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
            {t("selection.askAgent")}
          </Button>
          <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10" onClick={() => void trashFiles(rootId, live).then(onClear)} disabled={!live.length}>
            <Trash2 />
            {t("selection.trash")}
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label={t("selection.clear")} title={t("selection.clearHint")}>
            <X />
          </Button>
        </div>
      </div>

      <PromptDialog
        open={dialog === "move"}
        title={t("selection.moveDialog.title", { count: live.length })}
        description={t("selection.moveDialog.description")}
        label={t("selection.moveDialog.label")}
        placeholder="Clients/{client}/{year}"
        suggestions={folders}
        confirm={t("selection.moveDialog.confirm")}
        onSubmit={(v) => void moveFiles(rootId, live, v)}
        onClose={() => setDialog(null)}
      />
      <PromptDialog
        open={dialog === "tag"}
        title={t("selection.tagDialog.title", { count: live.length })}
        label={t("selection.tagDialog.label")}
        placeholder={t("selection.tagDialog.placeholder")}
        confirm={t("selection.tagDialog.confirm")}
        onSubmit={(v) => void tagFiles(rootId, live, v)}
        onClose={() => setDialog(null)}
      />
      <PromptDialog
        open={dialog === "rename"}
        title={t("selection.renameDialog.title", { count: live.length })}
        description={t("selection.renameDialog.description")}
        label={t("selection.renameDialog.label")}
        initial="{date} {name}"
        confirm={t("selection.renameDialog.confirm")}
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
              {t("selection.renameDialog.useAI", { count: withSuggestions.length })}
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
