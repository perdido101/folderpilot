/** Quick look for a file on a server space: preview (image, PDF, text, video, audio) + details, without leaving the page. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@folderpilot/ui";
import { canThumbnail, isTextPreviewable, kindOf } from "@folderpilot/core";
import { formatBytes, formatDate } from "@/lib/format";
import type { SpaceFile } from "./api";

const MAX_PREVIEW = 50 * 1024 * 1024;
const MAX_TEXT = 200_000;

export function contentUrl(orgId: string, file: Pick<SpaceFile, "id" | "spaceId">) {
  return `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/orgs/${orgId}/spaces/${file.spaceId}/files/${file.id}/content`;
}

type Preview = { kind: "image" | "pdf" | "video" | "audio"; url: string } | { kind: "text"; text: string } | { kind: "none" } | { kind: "error"; message: string };

function previewKind(file: SpaceFile): "image" | "pdf" | "video" | "audio" | "text" | "none" {
  if (file.size > MAX_PREVIEW) return "none";
  if (canThumbnail(file.ext) && file.ext !== "svg") return "image";
  if (file.ext === "pdf") return "pdf";
  if (isTextPreviewable(file.ext) && !["html", "htm", "js", "css"].includes(file.ext)) return "text";
  // Google Docs/Sheets/Slides arrive as their text export.
  if (["gdoc", "gsheet", "gslides"].includes(file.ext)) return "text";
  const kind = kindOf(file.ext);
  return kind === "video" ? "video" : kind === "audio" ? "audio" : "none";
}

export function ServerQuickLook({ orgId, file, spaceName, onClose, onShowInSpace }: { orgId: string; file: SpaceFile | null; spaceName?: string; onClose: () => void; onShowInSpace?: (file: SpaceFile) => void }) {
  const { t } = useTranslation(["search", "common", "connect"]);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    setPreview(null);
    if (!file) return;
    const kind = previewKind(file);
    if (kind === "none") return setPreview({ kind: "none" });
    let url: string | null = null;
    let live = true;
    // Fetch as a blob: the API never renders files itself; the preview lives under the app's origin.
    fetch(contentUrl(orgId, file), { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? res.statusText);
        if (kind === "text") {
          const text = (await res.text()).slice(0, MAX_TEXT);
          if (live) setPreview({ kind: "text", text });
          return;
        }
        const type = kind === "pdf" ? "application/pdf" : (res.headers.get("content-type") ?? "");
        url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
        if (live) setPreview({ kind, url });
      })
      .catch((err: unknown) => live && setPreview({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, orgId]);

  return (
    <Dialog open={Boolean(file)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col gap-3">
        {file && (
          <>
            <DialogTitle className="truncate pr-6">{file.name}</DialogTitle>
            <DialogDescription className="truncate font-mono text-[11px]">
              {spaceName ? `${spaceName} · ` : ""}
              {file.path} · {formatBytes(file.size)} · {formatDate(file.mtime)}
            </DialogDescription>
            <div className="flex min-h-[240px] flex-1 items-center justify-center overflow-auto rounded-lg border bg-surface-2" data-testid="server-preview">
              {!preview ? (
                <Loader2 className="size-5 animate-spin text-muted" />
              ) : preview.kind === "image" ? (
                <img src={preview.url} alt={file.caption ?? file.name} className="max-h-[60vh] max-w-full object-contain" />
              ) : preview.kind === "pdf" ? (
                <iframe src={preview.url} title={file.name} className="h-[60vh] w-full" />
              ) : preview.kind === "video" ? (
                <video src={preview.url} controls className="max-h-[60vh] max-w-full" />
              ) : preview.kind === "audio" ? (
                <audio src={preview.url} controls />
              ) : preview.kind === "text" ? (
                <pre className="h-[60vh] w-full overflow-auto whitespace-pre-wrap p-3 text-left font-mono text-xs">{preview.text}</pre>
              ) : preview.kind === "error" ? (
                <p className="p-6 text-sm text-danger">{preview.message}</p>
              ) : (
                <p className="p-6 text-sm text-muted">{t("preview.none")}</p>
              )}
            </div>
            {(file.caption || file.category) && (
              <p className="text-sm">
                {file.category && <span className="mr-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{file.category}</span>}
                {file.caption}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" asChild>
                <a href={contentUrl(orgId, file)} download={file.name}>
                  <Download /> {t("preview.download")}
                </a>
              </Button>
              {file.webUrl && (
                <Button variant="outline" asChild>
                  <a href={file.webUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink /> {t("connect:space.openInDrive")}
                  </a>
                </Button>
              )}
              {onShowInSpace && (
                <Button onClick={() => onShowInSpace(file)}>
                  <ExternalLink /> {t("preview.showInSpace")}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
