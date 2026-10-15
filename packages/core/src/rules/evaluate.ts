import { cleanFolderPath, sanitizeSuggestedName } from "../naming";
import type { Id, IndexedFile, ProposedStep } from "../types";
import { OPS_BY_FIELD, type Condition, type Rule, type RuleMode, type RuleSchedule } from "./types";

const DAY = 86_400_000;

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function baseName(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

const list = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);

const MAX_PATTERN = 200;
/** Nested quantifiers like (a+)+ or (a*)* can take exponential time on some inputs. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

/** Why a regex can't be used in a rule, or null when it's fine. */
export function regexProblem(pattern: string): string | null {
  if (!pattern.trim()) return "The pattern is empty.";
  if (pattern.length > MAX_PATTERN) return `Patterns can be at most ${MAX_PATTERN} characters.`;
  if (NESTED_QUANTIFIER.test(pattern)) return "Nested repetition like (a+)+ is too slow to run safely.";
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid pattern.";
  }
}

const regexCache = new Map<string, RegExp | null>();
function safeRegex(pattern: string): RegExp | null {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = regexProblem(pattern) ? null : new RegExp(pattern, "i");
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return re;
}

/** Inputs to regex tests are capped so a pattern can't run over megabytes of text. */
const matchesPattern = (pattern: string, text: string) => safeRegex(pattern)?.test(text.slice(0, 20_000)) ?? false;

function textOp(op: Condition["op"], have: string, want: string): boolean {
  const h = have.toLowerCase();
  if (op === "contains") return h.includes(want);
  if (op === "is_not") return h !== want;
  return h === want;
}

export function matchesCondition(file: IndexedFile, c: Condition, now = Date.now()): boolean {
  const v = c.value.trim().toLowerCase();
  switch (c.field) {
    case "ext":
      return c.op === "is_not" ? !list(c.value).includes(file.ext) : list(c.value).includes(file.ext);
    case "kind":
      return c.op === "is_not" ? file.kind !== v : file.kind === v;
    case "name": {
      if (c.op === "matches") return matchesPattern(c.value.trim(), file.name);
      const n = file.name.toLowerCase();
      if (c.op === "contains") return n.includes(v);
      if (c.op === "not_contains") return !n.includes(v);
      if (c.op === "starts_with") return n.startsWith(v);
      return n === v || baseName(n) === v;
    }
    case "content": {
      const raw = `${file.textExcerpt ?? ""}\n${file.caption ?? ""}`;
      if (c.op === "matches") return matchesPattern(c.value.trim(), raw);
      const text = raw.toLowerCase();
      return c.op === "not_contains" ? !text.includes(v) : text.includes(v);
    }
    case "date": {
      if (c.op === "within_days") return now - file.mtime <= Number(v) * DAY;
      const t = Date.parse(c.value);
      if (Number.isNaN(t)) return false;
      return c.op === "before" ? file.mtime < t : file.mtime >= t;
    }
    case "size": {
      const bytes = Number(v) * 1024 * 1024;
      return c.op === "gt" ? file.size > bytes : file.size < bytes;
    }
    case "folder": {
      const f = folderOf(file.path).toLowerCase();
      const want = v.replace(/^\/+|\/+$/g, "");
      if (c.op === "contains") return f.includes(want);
      if (c.op === "starts_with") return f === want || f.startsWith(`${want}/`);
      return f === want;
    }
    case "category": {
      const cat = (file.category ?? "").toLowerCase();
      return c.op === "is_not" ? cat !== v : cat === v;
    }
    case "flag":
      return file.flags.some((f) => f === v);
    case "tag":
      return file.tags.some((t) => t.toLowerCase() === v);
    case "client":
      return textOp(c.op, file.client ?? "", v);
    case "docType":
      return textOp(c.op, file.docType ?? "", v);
    case "space":
      return c.op === "is_not" ? String(file.spaceId ?? "") !== c.value.trim() : String(file.spaceId ?? "") === c.value.trim();
  }
}

/** A rule applies to a file's space: no scope = every space. */
export const ruleInScope = (rule: Pick<Rule, "scopeSpaceId">, spaceId: Id | undefined) => rule.scopeSpaceId === undefined || rule.scopeSpaceId === null || String(rule.scopeSpaceId) === String(spaceId);

export function matchesRule(file: IndexedFile, rule: Rule, now = Date.now()): boolean {
  if (rule.type !== "structured" || rule.conditions.length === 0 || rule.archived) return false;
  if (!ruleInScope(rule, file.spaceId)) return false;
  return rule.match === "any"
    ? rule.conditions.some((c) => matchesCondition(file, c, now))
    : rule.conditions.every((c) => matchesCondition(file, c, now));
}

const TYPE_LABELS: Record<string, string> = {
  image: "Images",
  document: "Documents",
  spreadsheet: "Spreadsheets",
  video: "Videos",
  audio: "Audio",
  archive: "Archives",
  code: "Data",
  other: "Other",
};

/** Expand {year} {month} {day} {date} {category} {client} {docType} {type} {ext} {name} {folder} in a template. */
export function renderTemplate(template: string, file: IndexedFile): string {
  const d = new Date(file.mtime);
  const vars: Record<string, string> = {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, "0"),
    day: String(d.getDate()).padStart(2, "0"),
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    category: file.category || "Uncategorized",
    client: file.client || "No client",
    doctype: file.docType || "Other documents",
    type: TYPE_LABELS[file.kind] ?? "Other",
    ext: file.ext,
    name: baseName(file.name),
    folder: folderOf(file.path),
  };
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key.toLowerCase()] ?? m);
}


/** Steps one rule would produce for one file (empty if nothing would change). */
export function stepsForFile<F extends IndexedFile>(file: F, rule: Rule): ProposedStep<F["id"]>[] {
  const steps: ProposedStep<F["id"]>[] = [];
  let folder = folderOf(file.path);
  let name = file.name;
  const actor = `rule:${rule.id}`;
  for (const action of rule.actions) {
    switch (action.type) {
      case "move":
        folder = cleanFolderPath(renderTemplate(action.value, file));
        break;
      case "rename":
        name = sanitizeSuggestedName(renderTemplate(action.value, file), file.name);
        break;
      case "tag": {
        const tag = action.value.trim().toLowerCase();
        if (tag && !file.tags.includes(tag)) steps.push({ fileId: file.id, action: "tag", to: tag, before: file.tags.join(", ") || "—", after: [...file.tags, tag].join(", "), actor });
        break;
      }
      case "caption": {
        const caption = renderTemplate(action.value, file);
        if (caption !== file.caption) steps.push({ fileId: file.id, action: "caption", from: file.caption ?? "", to: caption, before: file.caption || "—", after: caption, actor });
        break;
      }
      case "set_category": {
        const category = renderTemplate(action.value, file).trim();
        if (category && category !== file.category) steps.push({ fileId: file.id, action: "category", from: file.category ?? "", to: category, before: file.category || "—", after: category, actor });
        break;
      }
      case "flag_review":
        if (file.status !== "needs_review") steps.push({ fileId: file.id, action: "flag", to: "review", before: file.status, after: "needs review", actor });
        break;
    }
  }
  const newPath = folder ? `${folder}/${name}` : name;
  if (newPath !== file.path) {
    steps.unshift({ fileId: file.id, action: name !== file.name && folder === folderOf(file.path) ? "rename" : "move", from: file.path, to: newPath, before: file.path, after: newPath, actor });
  }
  return steps;
}

/** Dry-run: which files a rule matches and what it would do to each. */
export function dryRun<F extends IndexedFile>(files: F[], rule: Rule, now = Date.now()) {
  const matches = files.filter((f) => f.status !== "trashed" && matchesRule(f, rule, now));
  const steps = matches.flatMap((f) => stepsForFile(f, rule));
  return { matches, steps };
}

/**
 * All enabled structured rules in priority order. A file's location is decided by the
 * first rule that moves/renames it; tags, captions, categories and flags from every matching rule apply.
 */
export function planAllRules<F extends IndexedFile>(files: F[], rules: Rule[], now = Date.now()): ProposedStep<F["id"]>[] {
  const ordered = rules.filter((r) => r.enabled && !r.archived && r.type === "structured").sort((a, b) => a.priority - b.priority);
  const steps: ProposedStep<F["id"]>[] = [];
  for (const file of files) {
    if (file.status === "trashed") continue;
    let placed = false;
    const seen = new Set<string>();
    for (const rule of ordered) {
      if (!matchesRule(file, rule, now)) continue;
      for (const step of stepsForFile(file, rule)) {
        const isPath = step.action === "move" || step.action === "rename";
        if (isPath && placed) continue;
        const key = `${step.action}:${isPath ? "" : step.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (isPath) placed = true;
        steps.push(step);
      }
    }
  }
  return steps;
}

export interface RulePlan<I extends Id = Id> {
  rule: Rule;
  mode: RuleMode;
  steps: ProposedStep<I>[];
}

/**
 * What the enabled rules would do to these files, grouped per rule (spec §8 order: priority, first matching move wins,
 * tags add up). Auto rules run by themselves; suggest rules become plans for a person to approve.
 */
export function rulesForFiles<F extends IndexedFile>(files: F[], rules: Rule[], now = Date.now()): RulePlan<F["id"]>[] {
  const steps = planAllRules(files, rules, now);
  const byActor = new Map<string, ProposedStep<F["id"]>[]>();
  for (const s of steps) byActor.set(s.actor ?? "", [...(byActor.get(s.actor ?? "") ?? []), s]);
  return rules
    .filter((r) => byActor.has(`rule:${r.id}`))
    .sort((a, b) => a.priority - b.priority)
    .map((rule) => ({ rule, mode: rule.mode ?? "suggest", steps: byActor.get(`rule:${rule.id}`)! }));
}

const INTERVAL: Record<Exclude<RuleSchedule, "none">, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000 };

/** Whether a scheduled rule should run now. */
export function isRuleDue(rule: Pick<Rule, "schedule" | "lastRunAt" | "enabled" | "archived">, now = Date.now()): boolean {
  if (!rule.enabled || rule.archived || !rule.schedule || rule.schedule === "none") return false;
  return rule.lastRunAt === undefined || now - rule.lastRunAt >= INTERVAL[rule.schedule];
}

/** The first reason a rule can't be saved (null = fine). Shared by the builder, the API and AI proposals. */
export function ruleProblem(rule: Pick<Rule, "type" | "name" | "conditions" | "actions" | "naturalText">): string | null {
  if (!rule.name.trim()) return "Give the rule a name.";
  if (rule.type === "natural") return rule.naturalText?.trim() ? null : "Describe the rule in a sentence.";
  if (rule.conditions.length === 0) return "Add at least one condition.";
  if (rule.actions.length === 0) return "Add at least one action.";
  for (const c of rule.conditions) {
    if (!OPS_BY_FIELD[c.field]?.includes(c.op)) return `"${c.op.replace("_", " ")}" doesn't work with ${c.field}.`;
    if (c.op === "matches") {
      const problem = regexProblem(c.value);
      if (problem) return problem;
    } else if (!c.value.trim()) return `Fill in a value for ${c.field}.`;
  }
  for (const a of rule.actions) if (a.type !== "flag_review" && !a.value.trim()) return `Fill in a value for "${a.type.replace("_", " ")}".`;
  return null;
}
