import { useEffect, useRef, useState, type DragEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertCircle, Bot, Check, FileText, Loader2, Paperclip, RotateCcw, Send, Square, X } from "lucide-react";
import { Button, cn } from "@folderpilot/ui";
import { db } from "@/lib/db";
import { api } from "@/lib/api";
import { getDragFiles, hasDragFiles } from "@/lib/dnd";
import { useSettings } from "@/lib/settings";
import { FileIcon } from "@/features/files/file-icon";
import { PlanCard } from "@/features/plans/plan-card";
import { ServerPlanById } from "@/features/server-space/server-approvals";
import { useActiveServerSpace, useOrgAIStatus, type SpaceFile } from "@/features/server-space/api";
import type { ActiveServerSpace } from "@/features/server-space/space-header";
import { useActiveRoot } from "@/hooks/use-active-root";
import { hydrate, scopeKey, useChat, useConversation, type ChatScope, type ToolChip, type UIMessage } from "@/stores/chat";
import { useSelection } from "@/stores/selection";

const SUGGESTIONS = ["organizeByClient", "findNda", "screenshotRule", "duplicates"] as const;

/** What the chat talks about: the open server space, else the open folder on this device. */
export function useChatScope(): { scope: ChatScope | null; space: ActiveServerSpace | null } {
  const space = useActiveServerSpace();
  const root = useActiveRoot();
  if (space) return { scope: { kind: "server", orgId: space.orgId, spaceId: space.id }, space };
  return { scope: root ? { kind: "device", rootId: root.id } : null, space: null };
}

export function FileChips({ ids, max = 12 }: { ids: string[]; max?: number }) {
  const numeric = ids.slice(0, max).map(Number);
  const files = useLiveQuery(() => db.files.bulkGet(numeric), [numeric.join()]);
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
              onClick={() => open(f.id, numeric)}
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

function ServerFileChips({ ids, space, max = 12 }: { ids: string[]; space: ActiveServerSpace; max?: number }) {
  const shown = ids.slice(0, max);
  const { t } = useTranslation(["agent", "common"]);
  const files = useQuery({
    queryKey: ["space", space.id, "files", "ids", shown.join()],
    enabled: shown.length > 0,
    queryFn: () => api<{ files: SpaceFile[] }>(`/api/orgs/${space.orgId}/spaces/${space.id}/files?ids=${shown.join(",")}&limit=100`),
  }).data?.files;
  if (!files?.length) return null;
  const byId = new Map(files.map((f) => [f.id, f]));
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((id) => {
        const f = byId.get(id);
        return (
          f && (
            <span key={id} title={f.path} className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-surface px-2 py-1 text-xs">
              <FileText className="size-3.5 text-muted" />
              <span className="truncate">{f.name}</span>
            </span>
          )
        );
      })}
      {ids.length > max && <span className="px-1 py-1 text-xs text-muted">{t("moreFiles", { count: ids.length - max })}</span>}
    </div>
  );
}

function ToolChips({ tools }: { tools: ToolChip[] }) {
  const { t } = useTranslation("agent");
  if (!tools.length) return null;
  return (
    <ul className="space-y-0.5" aria-label={t("tools.label")}>
      {tools.map((tool) => (
        <li key={tool.id} className="flex items-center gap-1.5 text-[11px] text-muted" data-testid="tool-chip">
          {tool.status === "running" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : tool.status === "done" ? (
            <Check className="size-3 text-success" />
          ) : (
            <AlertCircle className="size-3 text-warning" />
          )}
          <span className="font-medium">{t(`tools.names.${tool.name}`, { defaultValue: tool.name })}</span>
          {tool.summary && <span className="truncate">· {tool.summary}</span>}
        </li>
      ))}
    </ul>
  );
}

function Message({ m, compact, space }: { m: UIMessage; compact: boolean; space: ActiveServerSpace | null }) {
  const { t } = useTranslation(["agent", "common"]);
  const chips = (ids: string[], max?: number) => (space ? <ServerFileChips ids={ids} space={space} {...(max ? { max } : {})} /> : <FileChips ids={ids} {...(max ? { max } : {})} />);
  if (m.role === "user")
    return (
      <div className="ml-8 space-y-1.5 self-end">
        <p className="whitespace-pre-wrap rounded-lg bg-accent-soft px-3 py-2 text-sm">{m.text}</p>
        {m.fileIds.length > 0 && chips(m.fileIds, 4)}
      </div>
    );
  return (
    <div className="mr-4 space-y-2" data-testid={m.role === "assistant" ? "agent-reply" : "agent-error"}>
      <ToolChips tools={m.tools} />
      {(m.text || m.role === "error") && (
        <p className={cn("whitespace-pre-wrap text-sm", m.role === "error" && "text-danger")}>
          {m.role === "error" ? t("common:status.error", { message: m.text }) : m.text}
          {m.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" aria-hidden />}
        </p>
      )}
      {m.fileIds.length > 0 && chips(m.fileIds)}
      {m.planIds.map((id) => (space ? <ServerPlanById key={id} planId={id} space={space} compact={compact} /> : <PlanCard key={id} planId={Number(id)} compact={compact} />))}
    </div>
  );
}

/** The agent conversation: streamed messages, tool progress, plan cards, attachments and the prompt box. Reused by mini mode. */
export function AgentChat({ compact = false }: { compact?: boolean }) {
  const { scope, space } = useChatScope();
  const key = scope ? scopeKey(scope) : null;
  const { messages } = useConversation(scope);
  const { busyKey, attachments, send, stop, detach, attach, reset } = useChat();
  const busy = busyKey !== null;
  const settings = useSettings();
  const orgAI = useOrgAIStatus(space?.orgId).data;
  const noAI = space ? orgAI !== undefined && !orgAI.label : settings.ai.provider === "none";
  const { t } = useTranslation(["agent", "common"]);
  const [text, setText] = useState("");
  const [dropping, setDropping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);

  useEffect(() => {
    if (scope) hydrate(scope);
  }, [key]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, last?.text.length, last?.tools.length, busy]);

  const submit = (value = text) => {
    if (!scope || !value.trim() || busy) return;
    void send(scope, value);
    setText("");
  };
  const onDrop = (e: DragEvent) => {
    if (!hasDragFiles(e) || space) return;
    e.preventDefault();
    setDropping(false);
    attach(getDragFiles(e));
  };

  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col", dropping && "bg-accent-soft/40")}
      onDragOver={(e) => {
        if (!hasDragFiles(e) || space) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-2 text-center">
            <div className="rounded-full bg-accent-soft p-3 text-accent">
              <Bot className="size-5" />
            </div>
            <p className="font-medium">{t("empty.title")}</p>
            <p className="text-xs text-muted">{t("empty.hint")}</p>
            {noAI && <p className="text-xs text-warning">{space ? t("empty.noOrgAI") : t("empty.noAI")}</p>}
            <div className="mt-2 flex flex-col gap-1.5">
              {SUGGESTIONS.map((k) => (
                <button
                  key={k}
                  disabled={!scope || busy}
                  onClick={() => submit(t(`suggestions.${k}`))}
                  className="rounded-lg border px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
                >
                  {t(`suggestions.${k}`)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} m={m} compact={compact} space={space} />)
        )}
        {busy && busyKey === key && !last?.text && !last?.tools.length && (
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
        {attachments.length > 0 && !space && (
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
            placeholder={scope ? t("input.placeholder") : t("input.placeholderNoFolder")}
            disabled={!scope}
            className="min-h-9 flex-1 resize-none rounded-lg border bg-surface px-3 py-2 text-sm placeholder:text-muted"
            aria-label={t("input.label")}
          />
          {busy ? (
            <Button size="icon" type="button" variant="outline" onClick={stop} aria-label={t("input.stop")}>
              <Square />
            </Button>
          ) : (
            <Button size="icon" type="submit" disabled={!text.trim() || !scope} aria-label={t("input.send")}>
              <Send />
            </Button>
          )}
        </form>
        {messages.length > 0 && !compact && scope && (
          <button className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-text disabled:opacity-50" onClick={() => reset(scope)} disabled={busy}>
            <RotateCcw className="size-3" /> {t("newConversation")}
          </button>
        )}
      </div>
    </div>
  );
}

function AttachmentChips({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
  const numeric = ids.map(Number);
  const files = useLiveQuery(() => db.files.bulkGet(numeric), [ids.join()]);
  const { t } = useTranslation(["agent", "common"]);
  return (
    <>
      {files?.map(
        (f) =>
          f && (
            <span key={f.id} className="inline-flex max-w-[160px] items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-xs">
              <span className="truncate">{f.name}</span>
              <button onClick={() => onRemove(String(f.id))} aria-label={t("removeAttachment", { name: f.name })} className="text-muted hover:text-text">
                <X className="size-3" />
              </button>
            </span>
          ),
      )}
    </>
  );
}
