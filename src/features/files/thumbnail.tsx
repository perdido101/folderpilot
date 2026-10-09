import { useEffect, useRef, useState } from "react";
import type { FileRecord } from "@/lib/db";
import { canThumbnail } from "@/lib/file-kinds";
import { getThumbnail } from "@/lib/thumbnails";
import { FileIcon } from "./file-icon";

/** Lazily generates a thumbnail once the tile scrolls into view. `accessKey` changes when folder access is granted. */
export function Thumbnail({ file, accessKey }: { file: FileRecord; accessKey: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canThumbnail(file.ext)) return;
    const io = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [file.ext]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void getThumbnail(file).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
  }, [visible, file, accessKey]);

  return (
    <div ref={ref} className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-surface-2">
      {url ? (
        <img src={url} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        <FileIcon kind={file.kind} className="size-8" />
      )}
    </div>
  );
}
