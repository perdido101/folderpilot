/**
 * Where a folder's files come from.
 * - "handle": File System Access API (Chrome/Edge). Read + write: FolderPilot can organize files.
 * - "memory": the standard folder picker / drag-and-drop that every browser supports (Brave, Firefox,
 *   Safari…). Read-only: browsing, analysis, AI and the agent work, but nothing can be moved on disk.
 */
import { shouldSkip } from "./file-kinds";
import { isFileSystemAccessSupported, pickDirectory } from "./fs-access";

export type FolderSource =
  | { kind: "handle"; name: string; handle: FileSystemDirectoryHandle }
  | { kind: "memory"; name: string; files: Map<string, File> };

const visible = (path: string) => path.split("/").every((part) => part && !shouldSkip(part));

/** Fallback picker: <input type="file" webkitdirectory>. Resolves null if the user cancels. */
function pickWithInput(): Promise<FolderSource | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const list = [...(input.files ?? [])];
      input.remove();
      if (!list.length) return resolve(null);
      const name = list[0]!.webkitRelativePath.split("/")[0] || "Folder";
      const files = new Map<string, File>();
      for (const f of list) {
        const path = f.webkitRelativePath.split("/").slice(1).join("/"); // drop the folder's own name
        if (path && visible(path)) files.set(path, f);
      }
      resolve({ kind: "memory", name, files });
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** "Choose folder": read/write when the browser allows it, otherwise read-only. */
export async function chooseFolder(): Promise<FolderSource | null> {
  if (isFileSystemAccessSupported()) {
    const handle = await pickDirectory();
    return handle ? { kind: "handle", name: handle.name, handle } : null;
  }
  return pickWithInput();
}

function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next(); // readEntries returns at most ~100 entries per call
      }, reject);
    next();
  });
}

async function collect(entry: FileSystemEntry, prefix: string, out: Map<string, File>) {
  if (shouldSkip(entry.name)) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.set(path, file);
  } else if (entry.isDirectory) {
    for (const child of await readEntries(entry as FileSystemDirectoryEntry)) await collect(child, path, out);
  }
}

/**
 * Read a dropped folder. Must be called synchronously inside the drop handler: DataTransfer items
 * are only readable during the event, so handles/entries are grabbed before awaiting anything.
 */
export function folderFromDrop(dt: DataTransfer): Promise<FolderSource | null> {
  const items = Array.from(dt.items).filter((i) => i.kind === "file");
  if (items.length && items.every((i) => typeof i.getAsFileSystemHandle === "function") && isFileSystemAccessSupported()) {
    const pending = items.map((i) => i.getAsFileSystemHandle!());
    return Promise.all(pending).then((handles) => {
      const dir = handles.find((h): h is FileSystemDirectoryHandle => h?.kind === "directory");
      return dir ? { kind: "handle", name: dir.name, handle: dir } : null;
    });
  }
  const entries = items.map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
  const dir = entries.find((e) => e.isDirectory) as FileSystemDirectoryEntry | undefined;
  if (!dir) return Promise.resolve(null);
  return (async () => {
    const files = new Map<string, File>();
    for (const child of await readEntries(dir)) await collect(child, "", files);
    return { kind: "memory" as const, name: dir.name, files };
  })();
}
