import type { AuditRecord } from "../db";

/**
 * Ids of audit entries that have been undone. The log is append-only, so "undone" is derived from later
 * undo events (`undoesEventId`); rows undone before v3 carry a legacy `undone` flag.
 */
export function undoneIds(entries: Pick<AuditRecord, "id" | "undoesEventId" | "undone">[]): Set<number> {
  return new Set(entries.flatMap((e) => (e.undoesEventId !== undefined ? [e.undoesEventId] : e.undone ? [e.id] : [])));
}
