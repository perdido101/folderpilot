export type FileKind = "image" | "document" | "spreadsheet" | "video" | "audio" | "archive" | "code" | "other";

const KINDS: Record<Exclude<FileKind, "other">, readonly string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff", "svg", "ico"],
  document: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "ppt", "pptx", "odp", "key"],
  spreadsheet: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"],
  video: ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv"],
  audio: ["mp3", "wav", "m4a", "flac", "ogg", "aac", "wma"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
  code: ["json", "xml", "html", "htm", "css", "js", "ts", "py", "yml", "yaml", "log", "ini", "sql"],
};

const BY_EXT = new Map<string, FileKind>(
  Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind as FileKind] as const)),
);

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function kindOf(ext: string): FileKind {
  return BY_EXT.get(ext.toLowerCase()) ?? "other";
}

/** Images the browser can decode into a thumbnail (HEIC/TIFF are not decodable in Chrome). */
export function canThumbnail(ext: string): boolean {
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "svg", "ico"].includes(ext);
}

/** Files we can show as plain text in quick-look. */
export function isTextPreviewable(ext: string): boolean {
  return ["txt", "md", "csv", "tsv", "json", "xml", "log", "ini", "yml", "yaml", "html", "htm", "css", "js", "ts", "py", "sql"].includes(ext);
}

const SYSTEM_NAMES = new Set([
  "desktop.ini",
  "thumbs.db",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "$recycle.bin",
  "system volume information",
  "recycler",
  "icon\r",
]);

export const TRASH_DIR = ".folderpilot-trash";

/**
 * Hidden/system entries are never indexed: dot-files and dot-folders (this includes .folderpilot-trash),
 * Office lock files (~$...), and well-known Windows/macOS system files.
 * Note: the browser cannot see the Windows "hidden" attribute, so name patterns are all we have.
 */
export function shouldSkip(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~$")) return true;
  return SYSTEM_NAMES.has(name.toLowerCase());
}
