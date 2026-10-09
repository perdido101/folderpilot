import { useEffect, useState } from "react";
import type { FileRecord } from "@/lib/db";
import { getFile } from "@/lib/file-access-cache";

/** Object URL for a file's current contents (revoked on change/unmount). */
export function useFileUrl(file: FileRecord | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!file) return;
    let cancelled = false;
    let created: string | null = null;
    void getFile(file).then((blob) => {
      if (cancelled || !blob) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    });
    return () => {
      cancelled = true;
      if (created) setTimeout(URL.revokeObjectURL, 1000, created);
    };
    // Re-read only when the file itself changes, not on every index update.
  }, [file?.id, file?.path, file?.mtime]);
  return url;
}
