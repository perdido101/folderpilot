/** One toast for what rules just did: auto changes (with Undo where possible) and suggestions waiting for approval. */
import i18n from "@/i18n";
import { toast } from "@/stores/toasts";

export interface AnnouncedOutcome {
  mode: "suggest" | "auto";
  files: number;
  done?: number;
  failed?: number;
  error?: string;
}

export function announceRuleOutcomes(outcomes: AnnouncedOutcome[], opts: { quietWhenNothing?: boolean; openApprovals?: () => void } = {}) {
  const t = i18n.getFixedT(null, "rules");
  const changed = outcomes.filter((o) => o.mode === "auto").reduce((n, o) => n + (o.done ?? 0), 0);
  const failed = outcomes.filter((o) => o.mode === "auto").reduce((n, o) => n + (o.failed ?? 0) + (o.error ? 1 : 0), 0);
  const suggested = outcomes.filter((o) => o.mode === "suggest").reduce((n, o) => n + o.files, 0);
  const parts = [
    changed ? t("results.auto", { count: changed }) : "",
    suggested ? t("results.suggested", { count: suggested }) : "",
    failed ? t("results.failed", { count: failed, error: outcomes.find((o) => o.error)?.error ?? "" }) : "",
  ].filter(Boolean);
  if (!parts.length) {
    if (!opts.quietWhenNothing) toast(t("results.nothing"));
    return;
  }
  toast(parts.join(" · "), failed ? "error" : "success", suggested && opts.openApprovals ? { label: t("results.review"), run: opts.openApprovals } : undefined);
}
