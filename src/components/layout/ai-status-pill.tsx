import { Link } from "react-router-dom";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createProvider } from "@/lib/ai";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { TestConnection } from "@/features/settings/settings-page";

/** "Local AI" (green) or "Your cloud: <name>" (blue), with a test-connection button. */
export function AiStatusPill() {
  const settings = useSettings();
  const provider = createProvider(settings.ai);
  const kind = settings.ai.provider;
  const label = provider ? provider.label : kind === "none" ? "AI off" : "AI not set up";
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
          aria-label={`AI status: ${label}`}
        >
          <span className={cn("size-2 shrink-0 rounded-full", dot)} />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">
          {kind === "ollama"
            ? "Runs on this computer — nothing leaves your machine."
            : kind === "none"
              ? "Local analysis (duplicates, bad photos, keyword search) works without AI."
              : "Only thumbnails (≤512px) and extracted text are sent to your endpoint. Never whole files."}
        </p>
        {kind !== "none" && <TestConnection />}
        <Link to="/settings" className="inline-block text-xs font-medium text-accent hover:underline">
          Open AI settings →
        </Link>
      </PopoverContent>
    </Popover>
  );
}
