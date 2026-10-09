/** Bulk "organize" proposals. They become pending plans that the user reviews and approves. */
import { db, type FileRecord } from "../db";
import { planAllRules, renderTemplate } from "../rules/evaluate";
import { createPlan } from "./engine";
import { renameSteps } from "./user-actions";

const live = (files: FileRecord[]) => files.filter((f) => f.status !== "trashed");

export async function proposeSuggestedNames(rootId: number, files: FileRecord[]): Promise<number | null> {
  const steps = renameSteps(live(files).filter((f) => f.suggestedName), "ai");
  if (!steps.length) return null;
  return createPlan({ rootId, source: "user", actor: "user", summary: "Rename files to AI-suggested names", steps });
}

export async function proposeFolders(rootId: number, files: FileRecord[], template: string): Promise<number | null> {
  const steps = live(files).flatMap((f) => {
    const folder = renderTemplate(template, f)
      .split("/")
      .map((s) => s.trim().replace(/[<>:"|?*\\]/g, ""))
      .filter((s) => s && s !== "..")
      .join("/");
    const to = `${folder}/${f.name}`;
    return to === f.path ? [] : [{ fileId: f.id, action: "move" as const, from: f.path, to, before: f.path, after: to }];
  });
  if (!steps.length) return null;
  return createPlan({ rootId, source: "user", actor: "user", summary: `Organize into folders: ${template}`, steps });
}

export async function proposeRules(rootId: number, ruleId?: number): Promise<number | null> {
  const files = await db.files.where("rootId").equals(rootId).toArray();
  const rules = (await db.rules.toArray()).filter((r) => ruleId === undefined || r.id === ruleId);
  const steps = planAllRules(files, ruleId === undefined ? rules : rules.map((r) => ({ ...r, enabled: true })));
  if (!steps.length) return null;
  const name = ruleId !== undefined ? rules[0]?.name : undefined;
  return createPlan({ rootId, source: "rule", actor: ruleId !== undefined ? `rule:${ruleId}` : "rule", summary: name ? `Run rule “${name}”` : "Run all rules", steps });
}
