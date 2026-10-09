import type { FileRecord, PlanStep } from "../db";
import { sanitizeSuggestedName } from "../ai/parse";
import type { Condition, Rule } from "./types";

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

export function matchesCondition(file: FileRecord, c: Condition, now = Date.now()): boolean {
  const v = c.value.trim().toLowerCase();
  switch (c.field) {
    case "ext":
      return c.op === "is_not" ? !list(c.value).includes(file.ext) : list(c.value).includes(file.ext);
    case "kind":
      return c.op === "is_not" ? file.kind !== v : file.kind === v;
    case "name": {
      const n = file.name.toLowerCase();
      if (c.op === "contains") return n.includes(v);
      if (c.op === "not_contains") return !n.includes(v);
      if (c.op === "starts_with") return n.startsWith(v);
      return n === v || baseName(n) === v;
    }
    case "content": {
      const text = `${file.textExcerpt ?? ""}\n${file.caption ?? ""}`.toLowerCase();
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
  }
}

export function matchesRule(file: FileRecord, rule: Rule, now = Date.now()): boolean {
  if (rule.type !== "structured" || rule.conditions.length === 0) return false;
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

/** Expand {year} {month} {day} {category} {client} {type} {ext} {name} {folder} in a template. */
export function renderTemplate(template: string, file: FileRecord): string {
  const d = new Date(file.mtime);
  const vars: Record<string, string> = {
    year: String(d.getFullYear()),
    month: String(d.getMonth() + 1).padStart(2, "0"),
    day: String(d.getDate()).padStart(2, "0"),
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    category: file.category || "Uncategorized",
    client: file.client || "No client",
    type: TYPE_LABELS[file.kind] ?? "Other",
    ext: file.ext,
    name: baseName(file.name),
    folder: folderOf(file.path),
  };
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key.toLowerCase()] ?? m);
}

function cleanFolder(path: string): string {
  return path
    .split(/[\\/]+/)
    .map((s) => s.trim().replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/[. ]+$/, ""))
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

/** Steps one rule would produce for one file (empty if nothing would change). */
export function stepsForFile(file: FileRecord, rule: Rule): PlanStep[] {
  const steps: PlanStep[] = [];
  let folder = folderOf(file.path);
  let name = file.name;
  const actor = `rule:${rule.id}`;
  for (const action of rule.actions) {
    switch (action.type) {
      case "move":
        folder = cleanFolder(renderTemplate(action.value, file));
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
export function dryRun(files: FileRecord[], rule: Rule, now = Date.now()) {
  const matches = files.filter((f) => f.status !== "trashed" && matchesRule(f, rule, now));
  const steps = matches.flatMap((f) => stepsForFile(f, rule));
  return { matches, steps };
}

/**
 * All enabled structured rules in priority order. A file's location is decided by the
 * first rule that moves/renames it; tags, captions, categories and flags from every matching rule apply.
 */
export function planAllRules(files: FileRecord[], rules: Rule[], now = Date.now()): PlanStep[] {
  const ordered = rules.filter((r) => r.enabled && r.type === "structured").sort((a, b) => a.priority - b.priority);
  const steps: PlanStep[] = [];
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
