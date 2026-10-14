import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Info, X } from "lucide-react";
import { isFileSystemAccessSupported } from "@/lib/fs-access";

/** Brave exposes navigator.brave; it ships the File System Access API behind a flag. */
const isBrave = () => typeof navigator !== "undefined" && "brave" in navigator;

export function BrowserNotice() {
  const { t } = useTranslation(["shell", "common"]);
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem("fp-hide-browser-notice") === "1";
    } catch {
      return false;
    }
  });
  if (isFileSystemAccessSupported() || hidden) return null;
  return (
    <div className="flex items-start gap-2 border-b bg-warning/10 px-4 py-2 text-sm text-warning">
      <Info className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <strong>{t("browserNotice.title")}</strong> {t("browserNotice.body")}{" "}
        {isBrave() ? (
          <Trans
            t={t}
            i18nKey="browserNotice.brave"
            components={{ code: <code className="rounded bg-surface px-1 font-mono text-xs" />, em: <em /> }}
            values={{ flag: "brave://flags/#file-system-access-api" }}
          />
        ) : (
          t("browserNotice.other")
        )}{" "}
        {t("browserNotice.privacy")}
      </p>
      <button
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem("fp-hide-browser-notice", "1");
          } catch {
            /* storage unavailable */
          }
        }}
        aria-label={t("common:actions.dismiss")}
        className="shrink-0"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
