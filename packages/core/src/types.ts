import type { FileKind } from "./file-kinds";

/** Ids are numbers in the local browser index and UUID strings on the server. */
export type Id = number | string;

export type FileStatus = "indexed" | "analyzed" | "needs_review" | "organized" | "trashed";

export type FileFlag = "duplicate" | "near_duplicate" | "blurry" | "dark" | "tiny" | "screenshot" | "suggested_delete";

export const FILE_FLAGS: readonly FileFlag[] = ["duplicate", "near_duplicate", "blurry", "dark", "tiny", "screenshot", "suggested_delete"];

/**
 * The indexed view of a file that the rules engine and analysis work on.
 * Both the browser index and the server `files` table satisfy this shape.
 */
export interface IndexedFile<I extends Id = Id> {
  id: I;
  path: string;
  name: string;
  ext: string;
  kind: FileKind;
  size: number;
  mtime: number;
  status: FileStatus;
  flags: FileFlag[];
  tags: string[];
  analyzedLocally?: boolean;
  sha256?: string;
  dhash?: string;
  blurScore?: number;
  brightness?: number;
  width?: number;
  height?: number;
  exif?: Record<string, string | number>;
  textExcerpt?: string;
  category?: string;
  caption?: string;
  client?: string;
}

/** Plan step actions. There is deliberately no "delete"; trash is human-only (enforced by the engine). */
export type StepAction =
  | "move"
  | "rename"
  | "createFolder"
  | "tag"
  | "untag"
  | "caption"
  | "category"
  | "trash"
  | "restore"
  | "flag"
  | "unflag"
  | "rule_create"
  | "rule_update";

/** One proposed change. `before`/`after` are display strings; `from`/`to` carry machine values. */
export interface ProposedStep<I extends Id = Id> {
  fileId?: I;
  action: StepAction;
  from?: string;
  to?: string;
  before?: string;
  after?: string;
  /** Overrides the plan actor in the audit log (e.g. "rule:3" inside a combined rules plan). */
  actor?: string;
}

export interface Thresholds {
  /** Max Hamming distance between dHashes to count as near-duplicates. */
  nearDuplicateDistance: number;
  /** Contrast-normalized sharpness below this = blurry. */
  blur: number;
  /** Mean luminance (0–255) below this = dark. */
  dark: number;
  /** Longest side below this (px) = tiny. */
  tiny: number;
  /** AI confidence below this goes to Needs Review. */
  confidence: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { nearDuplicateDistance: 6, blur: 60, dark: 45, tiny: 300, confidence: 0.6 };

/** Organization roles, most to least privileged. */
export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLES.indexOf(role) <= ROLES.indexOf(minimum);
}

/** The three product modes (§1). */
export type SpaceMode = "connect" | "cloud" | "private";
export type AdapterId = "local-browser" | "local-server" | "fp-cloud" | "gdrive" | "onedrive" | "dropbox";

export const ADAPTER_MODE: Record<AdapterId, SpaceMode> = {
  "local-browser": "private",
  "local-server": "private",
  "fp-cloud": "cloud",
  gdrive: "connect",
  onedrive: "connect",
  dropbox: "connect",
};

/** Audit actor strings (§6): user:<id> | agent:<user> | rule:<id> | mcp:<client>:<user>. */
export const actor = {
  user: (userId: Id) => `user:${userId}`,
  agent: (userId: Id) => `agent:${userId}`,
  rule: (ruleId: Id) => `rule:${ruleId}`,
  mcp: (client: string, userId: Id) => `mcp:${client}:${userId}`,
};
