import { Loader2, Sparkles } from "lucide-react";
import { useAnalysis } from "@/stores/analysis";

export function AnalysisStatus() {
  const { phase, done, total, lastError } = useAnalysis();
  if (phase === "idle") return lastError ? <span className="max-w-xs truncate text-xs text-danger" title={lastError}>Last error: {lastError}</span> : null;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted" role="status">
      {phase === "ai" ? <Sparkles className="size-3.5 animate-pulse text-accent" /> : <Loader2 className="size-3.5 animate-spin text-accent" />}
      {phase === "ai" ? "AI analyzing" : "Analyzing locally"} {done}/{total}
      <span className="h-1 w-20 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
