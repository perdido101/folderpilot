/**
 * One data layer for the Rules page and builder: folders on this device (Dexie + the browser engine) or a server space
 * (the organization's rules through the API). The UI is the same for both.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import { can, dryRun, type NewRule, type Rule } from "@folderpilot/core";
import { proposeStructuredRule } from "@folderpilot/ai";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { browserProvider } from "@/lib/ai/provider";
import { getSettings } from "@/lib/settings";
import { archiveRule, logRuleChange } from "@/lib/rules/store";
import { runRulesNow } from "@/lib/rules/device-runner";
import { useActiveRoot } from "@/hooks/use-active-root";
import { useActiveOrg, useServerSpaces } from "@/hooks/use-me";
import { useActiveServerSpace } from "@/features/server-space/api";
import { toast } from "@/stores/toasts";
import { fromServer, toServerBody, useServerRuleMutations, useServerRules, type RulePreview } from "./server-api";
import type { AnnouncedOutcome } from "./announce";

export interface RunSummary {
  outcomes: AnnouncedOutcome[];
  /** Device: a single suggestion plan to show right away. */
  singlePlanId?: number;
}

export interface RulesSource {
  kind: "device" | "server";
  /** A folder/space is open (needed to test and run rules). */
  ready: boolean;
  rules: Rule[] | undefined;
  /** Where a rule can be limited to (folders on this device, or server spaces). */
  scopes: { id: string; name: string }[];
  canManage: boolean;
  canAuto: boolean;
  save(rule: NewRule | Rule): Promise<boolean>;
  setEnabled(rule: Rule, enabled: boolean): Promise<void>;
  archive(rule: Rule): Promise<void>;
  reorder(list: Rule[]): Promise<void>;
  run(ruleId?: Rule["id"]): Promise<RunSummary | null>;
  preview(rule: NewRule | Rule): Promise<RulePreview>;
  /** Natural-language rule → structured proposal (shown in the builder, never saved automatically). */
  convert(text: string): Promise<NewRule | null>;
}

const message = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

function proposalToRule(p: Pick<NewRule, "name" | "match" | "conditions" | "actions">, priority: number): NewRule {
  return { type: "structured", name: p.name, enabled: true, priority, match: p.match, conditions: p.conditions, actions: p.actions, createdBy: "user", createdAt: Date.now(), mode: "suggest", schedule: "none" };
}

const sortRules = (rules: Rule[]) => rules.filter((r) => !r.archived).sort((a, b) => a.priority - b.priority);

export function useDeviceRulesSource(): RulesSource {
  const { t } = useTranslation("rules");
  const root = useActiveRoot();
  const rules = useLiveQuery(async () => sortRules(await db.rules.toArray()), []);
  const roots = useLiveQuery(() => db.roots.toArray(), []) ?? [];
  const rootId = root?.id ?? 0;
  return {
    kind: "device",
    ready: Boolean(root),
    rules,
    scopes: roots.map((r) => ({ id: String(r.id), name: r.name })),
    canManage: true,
    canAuto: true,
    async save(rule) {
      const scoped = rule.scopeSpaceId === undefined ? rule : { ...rule, scopeSpaceId: Number(rule.scopeSpaceId) };
      await logRuleChange(scoped, rootId);
      return true;
    },
    async setEnabled(rule, enabled) {
      await logRuleChange({ ...rule, enabled }, rootId);
    },
    async archive(rule) {
      await archiveRule(rule, rootId);
    },
    async reorder(list) {
      await db.transaction("rw", db.rules, async () => {
        for (const [k, r] of list.entries()) await db.rules.update(r.id, { priority: k + 1 });
      });
    },
    async run(ruleId) {
      if (!root) {
        toast(t("toasts.openFolder"));
        return null;
      }
      const outcomes = await runRulesNow(root.id, ruleId);
      const pending = outcomes.filter((o) => o.mode === "suggest");
      return {
        outcomes: outcomes.map((o) => ({ mode: o.mode, files: o.files, done: o.result?.done, failed: o.result ? o.result.failed + o.result.conflicted : 0, error: o.error })),
        ...(pending.length === 1 && outcomes.length === 1 ? { singlePlanId: pending[0]!.planId } : {}),
      };
    },
    async preview(rule) {
      const files = root ? await db.files.where("rootId").equals(root.id).toArray() : [];
      const names = new Map(files.map((f) => [f.id, f.name]));
      const { matches, steps } = dryRun(files, { ...rule, id: "id" in rule ? rule.id : -1 });
      return { matches: matches.length, changes: steps.length, steps: steps.slice(0, 10).map((s) => ({ name: names.get(s.fileId!) ?? "", action: s.action, before: s.before ?? "", after: s.after ?? s.to ?? "" })) };
    },
    async convert(text) {
      const settings = await getSettings();
      const provider = settings.ai.provider === "none" ? null : browserProvider(settings.ai);
      if (!provider) {
        toast(t("toasts.connectAI"));
        return null;
      }
      const categories = [...new Set((await db.files.toArray()).flatMap((f) => (f.category ? [f.category] : [])))].slice(0, 60);
      try {
        return proposalToRule(await proposeStructuredRule(provider, text, categories), (rules?.length ?? 0) + 1);
      } catch (err) {
        toast(message(err), "error");
        return null;
      }
    },
  };
}

export function useServerRulesSource(): RulesSource {
  const { t } = useTranslation("rules");
  const org = useActiveOrg();
  const orgId = org?.id ?? "";
  const space = useActiveServerSpace();
  const spaces = useServerSpaces(orgId || undefined).data ?? [];
  const query = useServerRules(orgId || undefined);
  const m = useServerRuleMutations(orgId);
  const role = org?.role ?? "viewer";
  const rules = query.data ? sortRules(query.data.rules.map(fromServer)) : undefined;

  /** Every rule change is audited on the server; offer Undo right away. */
  const done = (summary: string, batchId: string) =>
    toast(summary, "success", {
      label: t("results.undo"),
      run: async () => {
        try {
          await m.undo(batchId);
          toast(t("results.undone"));
        } catch (err) {
          toast(message(err), "error");
        }
      },
    });

  return {
    kind: "server",
    ready: Boolean(space),
    rules,
    scopes: spaces.map((s) => ({ id: s.id, name: s.name })),
    canManage: can(role, "rule", "manage"),
    canAuto: can(role, "settings", "manage"),
    async save(rule) {
      try {
        const res = "id" in rule ? await m.update(String(rule.id), toServerBody(rule)) : await m.create(rule);
        done(t("results.saved", { name: rule.name }), res.batchId);
        return true;
      } catch (err) {
        toast(message(err), "error");
        return false;
      }
    },
    async setEnabled(rule, enabled) {
      try {
        await m.update(String(rule.id), { enabled });
      } catch (err) {
        toast(message(err), "error");
      }
    },
    async archive(rule) {
      try {
        const res = await m.archive(String(rule.id));
        done(t("results.archived", { name: rule.name }), res.batchId);
      } catch (err) {
        toast(message(err), "error");
      }
    },
    async reorder(list) {
      try {
        for (const [k, r] of list.entries()) if (r.priority !== k + 1) await m.update(String(r.id), { priority: k + 1 });
      } catch (err) {
        toast(message(err), "error");
      }
    },
    async run(ruleId) {
      if (!space) {
        toast(t("toasts.openSpace"));
        return null;
      }
      try {
        const res = await m.run(space.id, ruleId === undefined ? undefined : String(ruleId));
        return {
          outcomes: res.outcomes.map((o) => ({ mode: o.mode, files: o.files, done: o.result?.done, failed: o.result ? o.result.failed + o.result.conflicted : 0, error: o.error })),
        };
      } catch (err) {
        toast(message(err), "error");
        return null;
      }
    },
    async preview(rule) {
      const scope = rule.scopeSpaceId === undefined ? space?.id : String(rule.scopeSpaceId);
      return m.preview(rule, scope);
    },
    async convert(text) {
      try {
        const { proposal } = await m.convert(text);
        return proposalToRule(proposal, (rules?.length ?? 0) + 1);
      } catch (err) {
        toast(message(err), "error");
        return null;
      }
    },
  };
}

/** The data layer for whatever is open: a server space, or folders on this device. */
export function useRulesSource(): RulesSource {
  const space = useActiveServerSpace();
  const device = useDeviceRulesSource();
  const server = useServerRulesSource();
  return space ? server : device;
}
