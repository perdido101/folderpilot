/**
 * Low-level disk operations. ONLY the action engine (engine.ts) may call these —
 * every disk change must be planned, logged and undoable.
 * There is deliberately no "delete file" operation: trashing is a move into .folderpilot-trash.
 */
import { TRASH_DIR } from "../file-kinds";

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i === -1 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export async function getDir(root: FileSystemDirectoryHandle, dir: string, create = false): Promise<FileSystemDirectoryHandle> {
  let handle = root;
  for (const part of dir.split("/").filter(Boolean)) handle = await handle.getDirectoryHandle(part, { create });
  return handle;
}

export async function exists(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const { dir, name } = splitPath(path);
  try {
    await (await getDir(root, dir)).getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** "a/b.pdf" → "a/b (2).pdf" → "a/b (3).pdf"… until the path is free. */
export async function uniquePath(root: FileSystemDirectoryHandle, path: string): Promise<string> {
  if (!(await exists(root, path))) return path;
  const { dir, name } = splitPath(path);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${dir ? `${dir}/` : ""}${base} (${n})${ext}`;
    if (!(await exists(root, candidate))) return candidate;
  }
}

/**
 * Move or rename a file inside a root folder. Uses FileSystemHandle.move() when the browser
 * supports it; otherwise copies to the destination, verifies the size, then removes the original.
 * Never overwrites: if the destination exists, " (2)" etc. is appended. Returns the final path.
 */
export async function moveFile(root: FileSystemDirectoryHandle, from: string, to: string): Promise<string> {
  if (from === to) return to;
  const src = splitPath(from);
  const srcDir = await getDir(root, src.dir);
  const srcHandle = await srcDir.getFileHandle(src.name);

  // A case-only rename ("a.pdf" → "A.pdf") finds itself on case-insensitive disks; don't suffix it.
  const final = from.toLowerCase() === to.toLowerCase() ? to : await uniquePath(root, to);
  const dst = splitPath(final);
  const dstDir = await getDir(root, dst.dir, true);

  if (typeof srcHandle.move === "function") {
    try {
      await srcHandle.move(dstDir, dst.name);
      return final;
    } catch {
      // Fall back to copy + verify + remove (e.g. unsupported on this file system).
    }
  }

  if (from.toLowerCase() === final.toLowerCase()) {
    // Case-only rename without native move: on a case-insensitive disk the destination IS the
    // source, so copying onto it and removing the "original" would lose the file. Go via a temp name.
    const temp = `.fp-rename-${Date.now().toString(36)}`;
    await copyThenRemove(srcDir, src.name, srcDir, temp);
    await copyThenRemove(srcDir, temp, dstDir, dst.name);
    return final;
  }
  await copyThenRemove(srcDir, src.name, dstDir, dst.name);
  return final;
}

/** Copy, verify the size, and only then remove the source. */
async function copyThenRemove(srcDir: FileSystemDirectoryHandle, srcName: string, dstDir: FileSystemDirectoryHandle, dstName: string) {
  const file = await (await srcDir.getFileHandle(srcName)).getFile();
  const dstHandle = await dstDir.getFileHandle(dstName, { create: true });
  const writable = await dstHandle.createWritable();
  await writable.write(file);
  await writable.close();
  const copied = await dstHandle.getFile();
  if (copied.size !== file.size) {
    await dstDir.removeEntry(dstName); // remove our incomplete copy, never the original
    throw new Error(`Copy of ${srcName} was incomplete (${copied.size} of ${file.size} bytes); original left in place.`);
  }
  await srcDir.removeEntry(srcName);
}

export function trashPathFor(path: string): string {
  return `${TRASH_DIR}/${path}`;
}
