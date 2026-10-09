import type { FileFlag, FileRecord } from "../db";
import type { Thresholds } from "../settings";
import { hammingHex, isScreenshot } from "./image-metrics";

export interface DuplicateGroup {
  kind: "exact" | "near";
  /** Suggested file to keep; the rest are the copies. */
  keep: FileRecord;
  others: FileRecord[];
}

/** Keep best: highest resolution → sharpest → oldest original → cleanest name ("(1)", "Copy" lose). */
export function pickBest(files: FileRecord[]): FileRecord {
  const copyName = /\(\d+\)|copy|αντίγραφο/i;
  return [...files].sort(
    (a, b) =>
      (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) ||
      (b.blurScore ?? 0) - (a.blurScore ?? 0) ||
      // "Oldest original" — but copies made within the same minute count as equally old.
      Math.floor(a.mtime / 60_000) - Math.floor(b.mtime / 60_000) ||
      Number(copyName.test(a.name)) - Number(copyName.test(b.name)) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  )[0]!;
}

const live = (f: FileRecord) => f.status !== "trashed";

export function exactGroups(files: FileRecord[]): DuplicateGroup[] {
  const bySha = new Map<string, FileRecord[]>();
  for (const f of files) {
    if (!live(f) || !f.sha256 || f.size === 0) continue;
    const list = bySha.get(f.sha256);
    if (list) list.push(f);
    else bySha.set(f.sha256, [f]);
  }
  return [...bySha.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const keep = pickBest(g);
      return { kind: "exact" as const, keep, others: g.filter((f) => f !== keep) };
    });
}

const aspect = (f: FileRecord) => (f.width && f.height ? Math.max(f.width, f.height) / Math.min(f.width, f.height) : 0);

/**
 * Near-duplicates: photos whose dHashes differ by at most `maxDistance` bits and whose aspect
 * ratios match, grouped with union-find. Exact copies are collapsed first so each group shows
 * distinct images. Screenshots are left out: UI layouts look alike to dHash even when the content differs.
 */
export function nearGroups(files: FileRecord[], maxDistance: number): DuplicateGroup[] {
  const exactLosers = new Set(exactGroups(files).flatMap((g) => g.others.map((f) => f.id)));
  const imgs = files.filter((f) => live(f) && f.dhash && !exactLosers.has(f.id) && !isScreenshot(f));
  const parent = imgs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < imgs.length; i++) {
    for (let j = i + 1; j < imgs.length; j++) {
      const a = imgs[i]!;
      const b = imgs[j]!;
      if (Math.abs(aspect(a) - aspect(b)) > 0.05) continue;
      if (hammingHex(a.dhash!, b.dhash!) <= maxDistance) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, FileRecord[]>();
  imgs.forEach((f, i) => {
    const r = find(i);
    const list = groups.get(r);
    if (list) list.push(f);
    else groups.set(r, [f]);
  });
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const keep = pickBest(g);
      return { kind: "near" as const, keep, others: g.filter((f) => f !== keep) };
    });
}

const COMPUTED: FileFlag[] = ["duplicate", "near_duplicate", "blurry", "dark", "tiny", "screenshot"];

/** Recompute every analysis flag from stored metrics. Leaves user/agent flags (suggested_delete) alone. */
export function computeFlags(files: FileRecord[], t: Thresholds): Map<number, FileFlag[]> {
  const dup = new Set(exactGroups(files).flatMap((g) => g.others.map((f) => f.id)));
  const near = new Set(nearGroups(files, t.nearDuplicateDistance).flatMap((g) => g.others.map((f) => f.id)));
  const result = new Map<number, FileFlag[]>();
  for (const f of files) {
    if (!f.analyzedLocally) continue;
    const flags: FileFlag[] = f.flags.filter((fl) => !COMPUTED.includes(fl));
    const screenshot = f.kind === "image" && isScreenshot(f);
    if (dup.has(f.id)) flags.push("duplicate");
    if (near.has(f.id)) flags.push("near_duplicate");
    if (screenshot) flags.push("screenshot");
    if (f.width && f.height) {
      if (Math.max(f.width, f.height) < t.tiny) flags.push("tiny");
      // Screenshots are flat UI by nature; only judge photos for blur/darkness.
      if (!screenshot && f.blurScore !== undefined && f.blurScore < t.blur) flags.push("blurry");
      if (!screenshot && f.brightness !== undefined && f.brightness < t.dark) flags.push("dark");
    }
    result.set(f.id, flags);
  }
  return result;
}
