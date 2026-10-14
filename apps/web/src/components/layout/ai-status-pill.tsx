import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { createProvider } from "@folderpilot/ai";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@folderpilot/ui";
import { useSettings } from "@/lib/settings";
import { TestConnection } from "@/features/settings/settings-page";

/** "Local AI" (green) or "Your cloud: <name>" (blue), with a test-connection button. */
export function AiStatusPill() {
  const { t } = useTranslation("shell");
  const settings = useSettings();
  const provider = createProvider(settings.ai);
  const kind = settings.ai.provider;
  const label = !provider
    ? kind === "none"
      ? t("ai.off")
      : t("ai.notSetUp")
    : kind === "ollama"
      ? t("ai.local")
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
        {kind !== "none" && <TestConnection />}
        <Link to="/settings" className="inline-block text-xs font-medium text-accent hover:underline">
          {t("ai.openSettings")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
