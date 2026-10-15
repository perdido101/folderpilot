import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { useTranslation } from "react-i18next";
import { Bot, FolderOpen, Keyboard, Monitor, Moon, PanelRight, RefreshCw, Sparkles, Sun, AppWindow } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@folderpilot/ui";
import { chooseFolder } from "@/lib/folder-source";
import { keywordSearch } from "@/lib/search";
import { runAIAnalysis } from "@/lib/ai/pipeline";
import { useVisibleNav } from "@/components/layout/sidebar";
import { FileIcon } from "@/features/files/file-icon";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { useChat } from "@/stores/chat";
import { useChatScope } from "@/components/layout/agent-panel";
import { useIndexing } from "@/stores/indexing";
import { useSelection } from "@/stores/selection";
import { toast } from "@/stores/toasts";
import { useUI } from "@/stores/ui";

const itemCls =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-accent-soft aria-selected:text-accent [&_svg]:size-4 [&_svg]:shrink-0";
const groupCls =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted";

export function openMiniWindow() {
  window.open(`${import.meta.env.BASE_URL}mini`, "folderpilot-mini", "popup,width=400,height=560");
}

/** Ctrl/⌘+K: navigation, actions, files, and "Ask the agent…". */
export function CommandPalette() {
  const nav = useVisibleNav();
  const { paletteOpen, setPaletteOpen, setTheme, toggleAgentPanel, agentPanelOpen, setShortcutsOpen } = useUI();
  const navigate = useNavigate();
  const root = useActiveRoot();
  const files = useRootFiles(root?.id);
  const connectFolder = useIndexing((s) => s.connectFolder);
  const send = useChat((s) => s.send);
  const chatScope = useChatScope().scope;
  const openQuickLook = useSelection((s) => s.openQuickLook);
  const [query, setQuery] = useState("");
  const { t } = useTranslation(["palette", "shell"]);

  const hits = useMemo(() => (query.trim().length > 1 && files ? keywordSearch(files, query).slice(0, 8) : []), [files, query]);
  const close = () => {
    setPaletteOpen(false);
    setQuery("");
  };
  const run = (fn: () => unknown) => () => {
    close();
    void fn();
  };

  return (
    <Dialog open={paletteOpen} onOpenChange={(o) => (o ? setPaletteOpen(true) : close())}>
      <DialogContent className="max-w-xl overflow-hidden p-0 [&>button]:hidden" onKeyDown={(e) => e.stopPropagation()}>
        <DialogTitle className="sr-only">{t("title")}</DialogTitle>
        <Command label={t("title")} className="flex max-h-[60vh] flex-col" shouldFilter>
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder={t("placeholder")}
            className="h-12 border-b bg-transparent px-4 text-sm outline-none placeholder:text-muted"
          />
          <Command.List className="overflow-y-auto p-2">
            <Command.Empty className="px-2 py-6 text-center text-sm text-muted">{t("empty")}</Command.Empty>
            {hits.length > 0 && (
              <Command.Group heading={t("groups.files")} className={groupCls}>
                {hits.map(({ file }) => (
                  <Command.Item
                    key={file.id}
                    value={`file ${file.id} ${query}`}
                    className={itemCls}
                    onSelect={run(() =>
                      openQuickLook(
                        file.id,
                        hits.map((h) => h.file.id),
                      ),
                    )}
                  >
                    <FileIcon kind={file.kind} />
                    <span className="truncate">{file.name}</span>
                    <span className="ml-auto truncate font-mono text-[11px] text-muted">{file.path}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            <Command.Group heading={t("groups.goTo")} className={groupCls}>
              {nav.map(({ to, labelKey, icon: Icon }) => (
                <Command.Item key={to} value={`go ${t(`shell:${labelKey}`)}`} className={itemCls} onSelect={run(() => navigate(to))}>
                  <Icon />
                  {t(`shell:${labelKey}`)}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading={t("groups.actions")} className={groupCls}>
              <Command.Item
                value={`choose open folder ${t("items.chooseFolder")}`}
                className={itemCls}
                onSelect={run(async () => {
                  const source = await chooseFolder();
                  if (source) await connectFolder(source);
                })}
              >
                <FolderOpen />
                {t("items.chooseFolder")}
              </Command.Item>
              {root?.handle && (
                <Command.Item
                  value={`rescan folder ${t("items.rescan", { name: root.name })}`}
                  className={itemCls}
                  onSelect={run(() => connectFolder(root.handle!))}
                >
                  <RefreshCw />
                  {t("items.rescan", { name: root.name })}
                </Command.Item>
              )}
              {root && (
                <Command.Item
                  value={`analyze with ai ${t("items.analyze")}`}
                  className={itemCls}
                  onSelect={run(() =>
                    runAIAnalysis(root.id)
                      .then((r) => toast(t("analyzed", { count: r.analyzed + r.review }), "success"))
                      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error")),
                  )}
                >
                  <Sparkles />
                  {t("items.analyze")}
                </Command.Item>
              )}
              <Command.Item value={`toggle agent panel ${t("items.toggleAgent")}`} className={itemCls} onSelect={run(toggleAgentPanel)}>
                <PanelRight />
                {t("items.toggleAgent")}
              </Command.Item>
              <Command.Item value={`mini mode window ${t("items.openMini")}`} className={itemCls} onSelect={run(openMiniWindow)}>
                <AppWindow />
                {t("items.openMini")}
              </Command.Item>
              <Command.Item value={`keyboard shortcuts help ${t("items.shortcuts")}`} className={itemCls} onSelect={run(() => setShortcutsOpen(true))}>
                <Keyboard />
                {t("items.shortcuts")}
              </Command.Item>
            </Command.Group>
            <Command.Group heading={t("groups.theme")} className={groupCls}>
              <Command.Item value={`theme light ${t("items.lightTheme")}`} className={itemCls} onSelect={run(() => setTheme("light"))}>
                <Sun />
                {t("items.lightTheme")}
              </Command.Item>
              <Command.Item value={`theme dark ${t("items.darkTheme")}`} className={itemCls} onSelect={run(() => setTheme("dark"))}>
                <Moon />
                {t("items.darkTheme")}
              </Command.Item>
              <Command.Item value={`theme system ${t("items.systemTheme")}`} className={itemCls} onSelect={run(() => setTheme("system"))}>
                <Monitor />
                {t("items.systemTheme")}
              </Command.Item>
            </Command.Group>
            {query.trim() && chatScope && (
              <Command.Group heading={t("groups.agent")} className={groupCls} forceMount>
                <Command.Item
                  forceMount
                  value="ask-the-agent"
                  className={itemCls}
                  onSelect={run(() => {
                    if (!agentPanelOpen) toggleAgentPanel();
                    return send(chatScope, query);
                  })}
                >
                  <Bot />
                  {t("items.ask", { query })}
                </Command.Item>
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
