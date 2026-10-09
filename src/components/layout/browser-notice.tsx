import { useState } from "react";
import { Info, X } from "lucide-react";
import { isFileSystemAccessSupported } from "@/lib/fs-access";

/** Brave exposes navigator.brave; it ships the File System Access API behind a flag. */
const isBrave = () => typeof navigator !== "undefined" && "brave" in navigator;

export function BrowserNotice() {
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
        <strong>Read-only mode.</strong> You can open folders, browse, find duplicates and use the AI and agent, but moving, renaming and trashing files needs
        the File System Access API.{" "}
        {isBrave() ? (
          <>
            In Brave, open <code className="rounded bg-surface px-1 font-mono text-xs">brave://flags/#file-system-access-api</code>, set it to <em>Enabled</em> and restart Brave.
          </>
        ) : (
          <>Use Chrome or Edge on desktop for full mode.</>
        )}{" "}
        Your files never leave your computer.
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
        aria-label="Dismiss"
        className="shrink-0"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
