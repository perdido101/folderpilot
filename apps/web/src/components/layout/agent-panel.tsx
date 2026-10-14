import { useEffect, useRef, useState, type DragEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import { Bot, Loader2, Paperclip, RotateCcw, Send, X } from "lucide-react";
import { Button } from "@folderpilot/ui";
import { db } from "@/lib/db";
import { getDragFiles, hasDragFiles } from "@/lib/dnd";
import { useSettings } from "@/lib/settings";
import { cn } from "@folderpilot/ui";
import { FileIcon } from "@/features/files/file-icon";
import { PlanCard } from "@/features/plans/plan-card";
import { useActiveRoot } from "@/hooks/use-active-root";
import { useChat, type UIMessage } from "@/stores/chat";
import { useSelection } from "@/stores/selection";

const SUGGESTIONS = ["organizeByClient", "findNda", "screenshotRule", "duplicates"] as const;

export function FileChips({ ids, max = 12 }: { ids: number[]; max?: number }) {
  const files = useLiveQuery(() => db.files.bulkGet(ids.slice(0, max)), [ids.join()]);
  const open = useSelection((s) => s.openQuickLook);
  const { t } = useTranslation(["agent", "common"]);
  if (!files?.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {files.map(
        (f) =>
          f && (
            <button
              key={f.id}
              onClick={() => open(f.id, ids)}
              title={f.path}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-surface px-2 py-1 text-xs hover:bg-surface-2"
            >
              <FileIcon kind={f.kind} className="size-3.5" />
              <span className="truncate">{f.name}</span>
            </button>
          ),
      )}
      {ids.length > max && <span className="px-1 py-1 text-xs text-muted">{t("moreFiles", { count: ids.length - max })}</span>}
    </div>
  );
}

function Message({ m, compact }: { m: UIMessage; compact: boolean }) {
  const { t } = useTranslation(["agent", "common"]);
  if (m.role === "user")
    return (
      <div className="ml-8 space-y-1.5 self-end">
        <p className="whitespace-pre-wrap rounded-lg bg-accent-soft px-3 py-2 text-sm">{m.text}</p>
        {m.fileIds.length > 0 && <FileChips ids={m.fileIds} max={4} />}
      </div>
    );
  return (
    <div className="mr-4 space-y-2">
      <p className={cn("whitespace-pre-wrap text-sm", m.role === "error" && "text-danger")}>
        {m.role === "error" ? t("common:status.error", { message: m.text }) : m.text}
      </p>
      {m.fileIds.length > 0 && <FileChips ids={m.fileIds} />}
      {m.planIds.map((id) => (
        <PlanCard key={id} planId={id} compact={compact} />
      ))}
    </div>
  );
}

/** The agent conversation: messages, plan cards, attachments and the prompt box. Reused by mini mode. */
export function AgentChat({ compact = false }: { compact?: boolean }) {
  const root = useActiveRoot();
  const { messages, busy, attachments, send, detach, attach, reset } = useChat();
  const settings = useSettings();
  const { t } = useTranslation(["agent", "common"]);
  const [text, setText] = useState("");
  const [dropping, setDropping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy]);

  const submit = (value = text) => {
    if (!root || !value.trim()) return;
    void send(root.id, value);
    setText("");
  };
  const onDrop = (e: DragEvent) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    attach(getDragFiles(e));
  };

  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col", dropping && "bg-accent-soft/40")}
      onDragOver={(e) => {
        if (!hasDragFiles(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-2 text-center">
            <div className="rounded-full bg-accent-soft p-3 text-accent">
              <Bot className="size-5" />
            </div>
            <p className="font-medium">{t("empty.title")}</p>
            <p className="text-xs text-muted">{t("empty.hint")}</p>
            {settings.ai.provider === "none" && <p className="text-xs text-warning">{t("empty.noAI")}</p>}
            <div className="mt-2 flex flex-col gap-1.5">
              {SUGGESTIONS.map((key) => (
                <button
                  key={key}
                  disabled={!root}
                  onClick={() => submit(t(`suggestions.${key}`))}
                  className="rounded-lg border px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
                >
                  {t(`suggestions.${key}`)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} m={m} compact={compact} />)
        )}
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> {t("thinking")}
          </p>
        )}
      </div>
      {dropping && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-accent text-sm font-medium text-accent">
          {t("dropFiles")}
        </div>
      )}
      <div className="border-t p-3">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <Paperclip className="size-3.5 text-muted" />
            <AttachmentChips ids={attachments} onRemove={detach} />
          </div>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            id="agent-input"
            rows={compact ? 1 : 2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={root ? t("input.placeholder") : t("input.placeholderNoFolder")}
            disabled={!root}
            className="min-h-9 flex-1 resize-none rounded-lg border bg-surface px-3 py-2 text-sm placeholder:text-muted"
            aria-label={t("input.label")}
          />
          <Button size="icon" type="submit" disabled={busy || !text.trim() || !root} aria-label={t("input.send")}>
            <Send />
          </Button>
        </form>
        {messages.length > 0 && !compact && (
          <button className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-text" onClick={reset}>
            <RotateCcw className="size-3" /> {t("newConversation")}
          </button>
        )}
      </div>
    </div>
  );
}

function AttachmentChips({ ids, onRemove }: { ids: number[]; onRemove: (id: number) => void }) {
  const files = useLiveQuery(() => db.files.bulkGet(ids), [ids.join()]);
  const { t } = useTranslation(["agent", "common"]);
  return (
    <>
      {files?.map(
        (f) =>
          f && (
            <span key={f.id} className="inline-flex max-w-[160px] items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-xs">
              <span className="truncate">{f.name}</span>
              <button onClick={() => onRemove(f.id)} aria-label={t("removeAttachment", { name: f.name })} className="text-muted hover:text-text">
                <X className="size-3" />
              </button>
            </span>
          ),
      )}
    </>
  );
}

export function AgentPanel() {
  const { t } = useTranslation(["agent", "common"]);
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l bg-surface" aria-label={t("panel.label")}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Bot className="size-4 text-accent" />
        <span className="font-medium">{t("panel.title")}</span>
        <span className="ml-auto text-xs text-muted">{t("panel.hint")}</span>
      </div>
      <AgentChat />
    </aside>
  );
}
