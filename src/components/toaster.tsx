import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { useToasts } from "@/stores/toasts";
import { cn } from "@/lib/utils";

const ICONS = { default: Info, success: CheckCircle2, error: CircleAlert };

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.tone];
          return (
            <motion.div
              key={t.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-surface px-3 py-2.5 text-sm shadow-sm"
              role="status"
            >
              <Icon className={cn("size-4 shrink-0", t.tone === "success" && "text-success", t.tone === "error" && "text-danger", t.tone === "default" && "text-muted")} />
              <span className="min-w-0 flex-1">{t.message}</span>
              {t.action && (
                <button
                  className="shrink-0 rounded-md px-2 py-1 font-medium text-accent hover:bg-accent-soft"
                  onClick={() => {
                    dismiss(t.id);
                    void t.action!.run();
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="shrink-0 text-muted hover:text-text" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X className="size-4" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
