import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import { toast } from "@/stores/toasts";
import { useReview, useUndoBatch, type ReviewAction } from "./api";

/** Run a review action (a plan through the engine) and show "… · Undo". */
export function useReviewAction(orgId: string, spaceId: string) {
  const { t } = useTranslation("spaces");
  const review = useReview(orgId, spaceId);
  const undo = useUndoBatch(orgId, spaceId);
  return {
    pending: review.isPending,
    async run(body: ReviewAction, summary: string) {
      try {
        const res = await review.mutateAsync(body);
        if (res.done === 0 && res.failed + res.conflicted > 0) {
          toast(t("results.failed", { count: res.failed + res.conflicted, error: res.errors[0] }), "error");
          return res;
        }
        const failed = res.failed + res.conflicted ? ` · ${t("results.failed", { count: res.failed + res.conflicted, error: res.errors[0] })}` : "";
        toast(`${summary}${failed}`, failed ? "error" : "success", res.batchId
          ? {
              label: t("results.undo"),
              run: async () => {
                const u = await undo.mutateAsync(res.batchId!);
                toast(u.failed ? t("results.failed", { count: u.failed, error: u.errors[0] }) : t("results.undone", { count: u.done }), u.failed ? "error" : "default");
              },
            }
          : undefined);
        return res;
      } catch (err) {
        toast(err instanceof ApiError || err instanceof Error ? err.message : String(err), "error");
        return null;
      }
    },
  };
}
