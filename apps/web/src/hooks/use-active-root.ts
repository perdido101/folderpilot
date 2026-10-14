import { useLiveQuery } from "dexie-react-hooks";
import { db, type FileRecord, type RootRecord } from "@/lib/db";
import { useUI } from "@/stores/ui";

/** The folder the user is looking at (last chosen, else most recent). */
export function useActiveRoot(): RootRecord | undefined | null {
  const activeRootId = useUI((s) => s.activeRootId);
  const roots = useLiveQuery(() => db.roots.orderBy("addedAt").toArray());
  if (roots === undefined) return undefined; // loading
  return roots.find((r) => r.id === activeRootId) ?? roots.at(-1) ?? null;
}

/** All indexed files of the active root (live). */
export function useRootFiles(rootId: number | undefined): FileRecord[] | undefined {
  return useLiveQuery(() => (rootId === undefined ? [] : db.files.where("rootId").equals(rootId).toArray()), [rootId]);
}
