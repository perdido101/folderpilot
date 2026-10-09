import { db } from "../db";
import type { NewRule, Rule } from "./types";

const batch = () => `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Save a user-made rule (create or update) and log it in the audit trail. */
export async function logRuleChange(rule: NewRule | Rule, rootId: number): Promise<number> {
  if ("id" in rule) {
    const old = await db.rules.get(rule.id);
    await db.rules.put(rule);
    await db.audit.add({ at: Date.now(), actor: "user", action: "rule_update", fileIds: [], from: JSON.stringify(old), to: JSON.stringify(rule), before: old?.name, after: rule.name, reason: "Edited rule", batchId: batch(), undone: false, rootId });
    return rule.id;
  }
  const id = await db.rules.add({ ...rule, createdAt: Date.now() });
  await db.audit.add({ at: Date.now(), actor: "user", action: "rule_create", fileIds: [], to: String(id), before: "—", after: rule.name, reason: "Created rule", batchId: batch(), undone: false, rootId });
  return id;
}

export async function deleteRule(rule: Rule, rootId: number) {
  await db.rules.delete(rule.id);
  // Logged as an update from the rule to nothing; undo restores it.
  await db.audit.add({ at: Date.now(), actor: "user", action: "rule_update", fileIds: [], from: JSON.stringify(rule), to: JSON.stringify({ deleted: true }), before: rule.name, after: "deleted", reason: "Deleted rule", batchId: batch(), undone: false, rootId });
}
