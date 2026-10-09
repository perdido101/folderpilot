/** One-click user actions: run through the engine, then show "… · Undo". */
import { db, type FileRecord, type PlanStep } from "../db";
import { sanitizeSuggestedName } from "../ai/parse";
import { renderTemplate } from "../rules/evaluate";
import { toast } from "@/stores/toasts";
import { executePlan, runUserAction, undoBatch, type ExecResult } from "./engine";

export function showResult(res: ExecResult) {
  if (res.done === 0 && res.failed > 0) {
    toast(`Nothing changed: ${res.errors[0]}`, "error");
    return;
  }
  const failed = res.failed ? ` · ${res.failed} failed` : "";
  if (!res.batchId) {
    toast(`${res.summary}${failed}`, res.failed ? "error" : "success");
    return;
  }
  toast(`${res.summary}${failed}`, res.failed ? "error" : "success", {
    label: "Undo",
    run: async () => {
      const u = await undoBatch(res.batchId);
      toast(
        u.failed ? `Undid ${u.undone}, ${u.failed} couldn't be undone: ${u.errors[0]}` : `Undone · ${u.undone} change${u.undone === 1 ? "" : "s"} reverted`,
        u.failed ? "error" : "default",
      );
    },
  });
}

async function run(rootId: number, summary: string, steps: PlanStep[], reason?: string) {
  if (steps.length === 0) {
    toast("Nothing to change.");
    return null;
  }
  try {
    const res = await runUserAction(rootId, summary, steps, reason);
    showResult(res);
    return res;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
    return null;
  }
}

/** Approve and execute a pending plan from a Plan Card. */
export async function approvePlan(planId: number) {
  try {
    const res = await executePlan(planId);
    showResult(res);
    return res;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), "error");
    return null;
  }
}

const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export const trashFiles = (rootId: number, files: FileRecord[], reason?: string) =>
  run(rootId, `Move ${files.length} to Trash`, files.filter((f) => f.status !== "trashed").map((f) => ({ fileId: f.id, action: "trash", from: f.path, before: f.path, after: "Trash" })), reason);

export const restoreFiles = (rootId: number, files: FileRecord[]) =>
  run(rootId, `Restore ${files.length}`, files.filter((f) => f.status === "trashed").map((f) => ({ fileId: f.id, action: "restore", from: f.path, to: f.trashedFrom, before: "Trash", after: f.trashedFrom })));

export function moveFiles(rootId: number, files: FileRecord[], folderTemplate: string) {
  const steps: PlanStep[] = files.flatMap((f) => {
    const folder = renderTemplate(folderTemplate, f).replace(/^\/+|\/+$/g, "");
    const to = join(folder, f.name);
    return to === f.path ? [] : [{ fileId: f.id, action: "move" as const, from: f.path, to, before: f.path, after: to }];
  });
  return run(rootId, `Move ${steps.length} files`, steps);
}

export function tagFiles(rootId: number, files: FileRecord[], tag: string) {
  const t = tag.trim().toLowerCase();
  return run(rootId, `Tag ${files.length}`, files.filter((f) => !f.tags.includes(t)).map((f) => ({ fileId: f.id, action: "tag", to: t, before: f.tags.join(", ") || "—", after: [...f.tags, t].join(", ") })));
}

export function untagFile(rootId: number, file: FileRecord, tag: string) {
  return run(rootId, "Remove tag", [{ fileId: file.id, action: "untag", to: tag, before: file.tags.join(", "), after: file.tags.filter((x) => x !== tag).join(", ") || "—" }]);
}

/** Rename by pattern ({name} {n} {date} {category} …) or to the AI's suggested names. */
export function renameSteps(files: FileRecord[], pattern: string | "ai"): PlanStep[] {
  return files.flatMap((f, i) => {
    const raw = pattern === "ai" ? f.suggestedName ?? "" : renderTemplate(pattern.replace(/\{n\}/g, String(i + 1).padStart(String(files.length).length, "0")), f);
    if (!raw) return [];
    const name = sanitizeSuggestedName(raw, f.name);
    const to = join(folderOf(f.path), name);
    return to === f.path ? [] : [{ fileId: f.id, action: "rename" as const, from: f.path, to, before: f.name, after: name }];
  });
}

export const renameFiles = (rootId: number, files: FileRecord[], pattern: string | "ai") => run(rootId, `Rename ${files.length}`, renameSteps(files, pattern));

export const renameOne = (rootId: number, file: FileRecord, newName: string) => {
  const name = sanitizeSuggestedName(newName, file.name);
  const to = join(folderOf(file.path), name);
  return run(rootId, "Rename", to === file.path ? [] : [{ fileId: file.id, action: "rename", from: file.path, to, before: file.name, after: name }]);
};

export const setCaption = (rootId: number, file: FileRecord, caption: string) =>
  run(rootId, "Edit caption", caption === (file.caption ?? "") ? [] : [{ fileId: file.id, action: "caption", from: file.caption ?? "", to: caption, before: file.caption || "—", after: caption || "—" }]);

export const setCategory = (rootId: number, files: FileRecord[], category: string) =>
  run(rootId, `Categorize ${files.length}`, files.filter((f) => f.category !== category || f.status === "needs_review").map((f) => ({ fileId: f.id, action: "category", to: category, before: f.category || "—", after: category })));

export const flagForReview = (rootId: number, files: FileRecord[], flag: "suggested_delete", reason: string) =>
  run(rootId, "Flag", files.filter((f) => !f.flags.includes(flag)).map((f) => ({ fileId: f.id, action: "flag", to: flag, before: "—", after: reason })));

export const unflag = (rootId: number, files: FileRecord[], flag: "suggested_delete") =>
  run(rootId, "Keep", files.filter((f) => f.flags.includes(flag)).map((f) => ({ fileId: f.id, action: "unflag", to: flag, before: "suggested for deletion", after: "kept" })));

/** Accept a low-confidence AI suggestion as-is. */
export async function acceptReview(files: FileRecord[]) {
  await db.files.bulkUpdate(files.map((f) => ({ key: f.id, changes: { status: "analyzed" as const } })));
  toast(`Accepted ${files.length} file${files.length === 1 ? "" : "s"}`, "success");
}
