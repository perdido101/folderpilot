/** "Make this a rule?": any page can open the rule builder pre-filled; the host lives in the app shell. */
import { create } from "zustand";
import type { NewRule } from "@folderpilot/core";
import { RuleBuilderDialog } from "./rule-builder";

interface DraftState {
  draft: NewRule | null;
  open: (draft: NewRule) => void;
  close: () => void;
}

export const useRuleDraft = create<DraftState>()((set) => ({
  draft: null,
  open: (draft) => set({ draft }),
  close: () => set({ draft: null }),
}));

/** A rule from one example the person just recategorized: same extension (+ folder, document type) → that category. */
export function ruleFromExample(example: { ext: string; folder?: string; docType?: string | null; nameWord?: string }, category: string): NewRule {
  const conditions: NewRule["conditions"] = [{ field: "ext", op: "is", value: example.ext }];
  if (example.docType) conditions.push({ field: "docType", op: "is", value: example.docType });
  else if (example.folder) conditions.push({ field: "folder", op: "is", value: example.folder });
  else if (example.nameWord) conditions.push({ field: "name", op: "contains", value: example.nameWord });
  const label = example.docType ?? example.nameWord ?? example.ext.toUpperCase();
  return { type: "structured", name: `${label} → ${category}`, enabled: true, priority: 99, match: "all", conditions, actions: [{ type: "set_category", value: category }], createdBy: "user", createdAt: Date.now(), mode: "suggest", schedule: "none" };
}

export function RuleDraftHost() {
  const { draft, close } = useRuleDraft();
  return draft ? <RuleBuilderDialog initial={draft} onClose={close} /> : null;
}
