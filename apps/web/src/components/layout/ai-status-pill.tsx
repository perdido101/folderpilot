import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useBrowserProvider } from "@/lib/ai/provider";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@folderpilot/ui";
import { useSettings } from "@/lib/settings";
import { TestConnection } from "@/features/settings/settings-page";
import { useActiveServerSpace, useOrgAIStatus } from "@/features/server-space/api";

/** "Local AI" (green) or "Your cloud: <name>" (blue), with a test-connection button. */
export function AiStatusPill() {
  const { t } = useTranslation("shell");
  const settings = useSettings();
  const deviceProvider = useBrowserProvider(settings.ai);
  // Viewing a server space: the organization's AI applies (configured by admins in Settings).
  const serverSpace = useActiveServerSpace();
  const orgAI = useOrgAIStatus(serverSpace?.orgId).data;
  const kind = serverSpace ? (orgAI?.provider ?? "none") : settings.ai.provider;
  const provider = serverSpace ? (orgAI?.label ? { label: orgAI.label } : null) : deviceProvider;
  const label = !provider
    ? kind === "none"
      ? t("ai.off")
      : t("ai.notSetUp")
    : kind === "folderpilot"
      ? t("ai.folderpilot")
      : kind === "ollama"
        ? t("ai.local")
        : serverSpace
          ? provider.label
          : t("ai.cloud", { name: kind === "openai" ? settings.ai.openai.name : settings.ai.anthropic.name });
  const dot = !provider ? "bg-muted/50" : kind === "ollama" ? "bg-success" : "bg-sky-500";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex h-7 max-w-56 items-center gap-2 rounded-full border px-3 text-xs transition-colors hover:bg-surface-2",
            provider && kind === "ollama" && "border-success/30 text-success",
            provider && kind !== "ollama" && "border-sky-500/30 text-sky-700 dark:text-sky-300",
            !provider && "text-muted",
          )}
          aria-label={t("ai.status", { label })}
        >
          <span className={cn("size-2 shrink-0 rounded-full", dot)} />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">{kind === "ollama" ? t("ai.localHint") : kind === "none" ? t("ai.offHint") : t("ai.cloudHint")}</p>
        {kind !== "none" && !serverSpace && <TestConnection />}
        <Link to="/settings" className="inline-block text-xs font-medium text-accent hover:underline">
          {t("ai.openSettings")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
