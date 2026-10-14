/** Characters Windows forbids in file/folder names, plus ASCII control characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Normalize a relative folder path: "/" separators, no forbidden characters,
 * no trailing dots/spaces, and no "." or ".." segments (so it can never escape the root).
 */
export function cleanFolderPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .map((s) => s.trim().replace(FORBIDDEN, "").replace(/[. ]+$/, ""))
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

/** Keep the original extension and strip characters Windows doesn't allow in file names. */
export function sanitizeSuggestedName(suggested: string, originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  const ext = dot > 0 ? originalName.slice(dot) : "";
  let base = suggested.trim();
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
  base = base.replace(FORBIDDEN, "").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim();
  return base ? `${base}${ext}` : originalName;
}
