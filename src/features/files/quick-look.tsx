import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { FileRecord } from "@/lib/db";
import { getFile } from "@/lib/file-access-cache";
import { isTextPreviewable } from "@/lib/file-kinds";
import { formatBytes, formatDate } from "@/lib/format";
import { FileIcon } from "./file-icon";

const TEXT_LIMIT = 200_000;

type Preview =
  | { type: "loading" }
  | { type: "unavailable" }
  | { type: "image" | "pdf" | "video" | "audio"; url: string }
  | { type: "text"; text: string; truncated: boolean }
  | { type: "none" };

function usePreview(file: FileRecord | undefined): Preview {
  const [preview, setPreview] = useState<Preview>({ type: "loading" });

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let url: string | null = null;
    setPreview({ type: "loading" });

    void (async () => {
      const blob = await getFile(file);
      if (cancelled) return;
      if (!blob) return setPreview({ type: "unavailable" });
      const media = file.kind === "image" ? "image" : file.ext === "pdf" ? "pdf" : file.kind === "video" ? "video" : file.kind === "audio" ? "audio" : null;
      if (media) {
        url = URL.createObjectURL(file.ext === "pdf" ? new Blob([blob], { type: "application/pdf" }) : blob);
        setPreview({ type: media, url });
      } else if (isTextPreviewable(file.ext)) {
        const text = await blob.slice(0, TEXT_LIMIT).text();
        if (!cancelled) setPreview({ type: "text", text, truncated: blob.size > TEXT_LIMIT });
      } else {
        setPreview({ type: "none" });
      }
    })();

    return () => {
      cancelled = true;
      // The closing dialog (and Chrome's PDF viewer) may still read the URL for a moment.
      if (url) setTimeout(URL.revokeObjectURL, 2000, url);
    };
  }, [file]);

  return preview;
}

function PreviewBody({ file, preview }: { file: FileRecord; preview: Preview }) {
  switch (preview.type) {
    case "loading":
      return <p className="text-muted">Loading…</p>;
    case "unavailable":
      return <p className="text-muted">Can't read this file. Allow folder access, or it may have been moved.</p>;
    case "image":
      return <img src={preview.url} alt={file.name} className="max-h-full max-w-full object-contain" />;
    case "pdf":
      return <iframe src={preview.url} title={file.name} className="size-full rounded-md bg-white" />;
    case "video":
      return <video src={preview.url} controls className="max-h-full max-w-full" />;
    case "audio":
      return <audio src={preview.url} controls />;
    case "text":
      return (
        <pre className="size-full overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-4 font-mono text-xs">
          {preview.text}
          {preview.truncated && "\n\n… (preview truncated)"}
        </pre>
      );
    case "none":
      return (
        <div className="flex flex-col items-center gap-3 text-muted">
          <FileIcon kind={file.kind} className="size-12" />
          <p>No preview for .{file.ext || "unknown"} files yet.</p>
        </div>
      );
  }
}

interface Props {
  files: FileRecord[];
  openId: number | null;
  onNavigate: (id: number | null) => void;
}

export function QuickLook({ files, openId, onNavigate }: Props) {
  const index = openId === null ? -1 : files.findIndex((f) => f.id === openId);
  const file = files[index];
  const preview = usePreview(file);

  const go = (delta: number) => {
    const next = files[index + delta];
    if (next) onNavigate(next.id);
  };

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && onNavigate(null)}>
      <DialogContent
        className="flex h-[85vh] max-w-5xl flex-col gap-3 p-4 focus-visible:ring-0"
        // Focus the dialog itself, not the first button, so Space/arrows never "click" Previous/Next.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowDown") go(1);
          else if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(-1);
          else if (e.key === " " && !(e.target instanceof HTMLMediaElement)) onNavigate(null);
          else return;
          e.preventDefault();
        }}
      >
        {file && (
          <>
            <div className="pr-8">
              <DialogTitle className="truncate">{file.name}</DialogTitle>
              <DialogDescription className="flex flex-wrap gap-x-4 font-mono text-xs">
                <span className="truncate">{file.path}</span>
                <span>{formatBytes(file.size)}</span>
                <span>{formatDate(file.mtime)}</span>
              </DialogDescription>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <PreviewBody file={file} preview={preview} />
            </div>
            <div className="flex items-center justify-between text-xs text-muted">
              <button onClick={() => go(-1)} disabled={index <= 0} className="inline-flex items-center gap-1 disabled:opacity-40">
                <ChevronLeft className="size-4" /> Previous
              </button>
              <span className="tabular-nums">
                {index + 1} / {files.length} · Space or Esc to close
              </span>
              <button onClick={() => go(1)} disabled={index >= files.length - 1} className="inline-flex items-center gap-1 disabled:opacity-40">
                Next <ChevronRight className="size-4" />
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
