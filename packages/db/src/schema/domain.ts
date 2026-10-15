/**
 * FolderPilot domain tables (CLAUDE.md §6). Every table carries `organization_id`, and every
 * query goes through the org-scoped data-access layer (`scoped()` in ../scoped.ts).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AutoRunSettings, Condition, RuleAction, RuleSchedule } from "@folderpilot/core";
import { organizations, users } from "./auth";

/** Postgres tsvector (read-only from the app: a trigger maintains it). */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const orgId = () =>
  text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

export const spaceMode = pgEnum("space_mode", ["connect", "cloud", "private"]);
export const adapterId = pgEnum("adapter_id", ["local-browser", "local-server", "fp-cloud", "gdrive", "onedrive", "dropbox"]);
export const fileStatus = pgEnum("file_status", ["indexed", "analyzed", "needs_review", "organized", "trashed"]);
export const ruleType = pgEnum("rule_type", ["structured", "natural"]);
export const ruleScope = pgEnum("rule_scope", ["org", "space", "folder"]);
export const ruleMode = pgEnum("rule_mode", ["suggest", "auto"]);
export const planSource = pgEnum("plan_source", ["user", "agent", "rule", "mcp"]);
export const planStatus = pgEnum("plan_status", ["pending", "approved", "executing", "executed", "partially_failed", "cancelled"]);
export const stepStatus = pgEnum("plan_step_status", ["pending", "done", "failed", "conflicted", "skipped"]);
export const sharePermission = pgEnum("share_permission", ["view", "download"]);

export interface SpaceSettings {
  /** Per-space AI override, e.g. /Legal = local only (§5). */
  aiProvider?: "inherit" | "folderpilot" | "ollama" | "openai" | "anthropic" | "none";
  /** Plans touching at most this many files may auto-run (§2). 0 = always ask. */
  autoRunThreshold?: number;
  /** Connect mode: the provider account (e.g. the Google email) and the chosen root folder's name. */
  account?: string;
  rootName?: string;
  /** Set when the provider stopped accepting our credentials (revoked/expired): the space needs reconnecting. */
  needsReconnect?: string | null;
  /** When the space was last scanned (ms). */
  lastScanAt?: number;
}

/** A connected source: a local folder, FolderPilot Cloud storage, or a Drive/OneDrive/Dropbox account. */
export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text("name").notNull(),
    mode: spaceMode("mode").notNull(),
    adapterId: adapterId("adapter_id").notNull(),
    /** Provider-specific root (folder id, path, bucket prefix). */
    rootRef: text("root_ref").notNull(),
    /** AES-256-GCM encrypted OAuth tokens / keys (never plaintext). */
    credentialsEncrypted: text("credentials_encrypted"),
    syncCursor: text("sync_cursor"),
    settings: jsonb("settings").$type<SpaceSettings>().notNull().default({}),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("spaces_org_idx").on(t.organizationId)],
);

export interface FileEntities {
  client?: string;
  date?: string;
  amount?: string;
  docType?: string;
}

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    /** Id/path of the item at the provider. */
    providerRef: text("provider_ref").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => files.id, { onDelete: "set null" }),
    isFolder: boolean("is_folder").notNull().default(false),
    path: text("path").notNull(),
    name: text("name").notNull(),
    ext: text("ext").notNull().default(""),
    mime: text("mime"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mtime: ts("mtime"),
    /** Provider version / etag, used for conflict checks (expectVersion). */
    version: text("version"),
    sha256: text("sha256"),
    dhash: text("dhash"),
    blurScore: real("blur_score"),
    brightness: real("brightness"),
    width: integer("width"),
    height: integer("height"),
    exif: jsonb("exif").$type<Record<string, string | number>>(),
    textExcerpt: text("text_excerpt"),
    category: text("category"),
    /** Who set the category: ai | rule | user (used by explain_categorization). */
    categorySource: text("category_source").$type<"ai" | "rule" | "user">(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    caption: text("caption"),
    suggestedName: text("suggested_name"),
    entities: jsonb("entities").$type<FileEntities>(),
    confidence: real("confidence"),
    /** One sentence from the AI: why this category. */
    aiReason: text("ai_reason"),
    /** Local analysis (hash, image metrics, EXIF, text) finished for the current version. */
    analyzedAt: ts("analyzed_at"),
    /** AI insight finished for the current version. */
    aiAnalyzedAt: ts("ai_analyzed_at"),
    /** When structured rules last looked at this file (rules re-run when analysis is newer). */
    rulesCheckedAt: ts("rules_checked_at"),
    status: fileStatus("status").notNull().default("indexed"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    /** Why a file was flagged (e.g. the agent's reason for suggested_delete). */
    flagReason: text("flag_reason"),
    embedding: vector("embedding", { dimensions: 1024 }),
    /** Which model made `embedding` (only vectors from the same model are compared). */
    embeddingModel: text("embedding_model"),
    /** Hash of the embedded text: unchanged text is never embedded twice. */
    embeddingHash: text("embedding_hash"),
    /** Full-text search document, maintained by the files_search_tsv trigger (migration 0007). */
    searchTsv: tsvector("search_tsv"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("files_space_ref_uq").on(t.spaceId, t.providerRef),
    index("files_org_idx").on(t.organizationId),
    index("files_space_parent_idx").on(t.spaceId, t.parentId),
    index("files_org_sha_idx").on(t.organizationId, t.sha256),
    index("files_org_status_idx").on(t.organizationId, t.status),
    index("files_org_category_idx").on(t.organizationId, t.category),
    index("files_tags_gin").using("gin", t.tags),
    index("files_flags_gin").using("gin", t.flags),
    index("files_search_tsv_gin").using("gin", t.searchTsv),
    index("files_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

/** File version history (Cloud mode). */
export const versions = pgTable(
  "versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    storageKey: text("storage_key").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("versions_file_version_uq").on(t.fileId, t.version), index("versions_org_idx").on(t.organizationId)],
);

export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    type: ruleType("type").notNull(),
    name: text("name").notNull(),
    scope: ruleScope("scope").notNull().default("org"),
    /** Space id or folder path when scope is space/folder. */
    scopeRef: text("scope_ref"),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    mode: ruleMode("mode").notNull().default("suggest"),
    match: text("match").$type<"all" | "any">().notNull().default("all"),
    conditions: jsonb("conditions").$type<Condition[]>().notNull().default([]),
    actions: jsonb("actions").$type<RuleAction[]>().notNull().default([]),
    naturalText: text("natural_text"),
    /** Limit the rule to one space (null = every space in the organization). */
    scopeSpaceId: uuid("scope_space_id").references(() => spaces.id, { onDelete: "set null" }),
    schedule: text("schedule").$type<RuleSchedule>().notNull().default("none"),
    lastRunAt: ts("last_run_at"),
    /** Rules are archived, never deleted (an archive is a plan step, so it's audited and undoable). */
    archivedAt: ts("archived_at"),
    /** Actor string, e.g. user:<id> or agent:<userId>. */
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("rules_org_priority_idx").on(t.organizationId, t.priority)],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
    source: planSource("source").notNull(),
    actor: text("actor").notNull(),
    summary: text("summary").notNull(),
    reason: text("reason"),
    status: planStatus("status").notNull().default("pending"),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    batchId: uuid("batch_id"),
    /** When set, executing this plan undoes that batch. */
    undoBatchId: uuid("undo_batch_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    executedAt: ts("executed_at"),
  },
  (t) => [index("plans_org_status_idx").on(t.organizationId, t.status), index("plans_org_created_idx").on(t.organizationId, t.createdAt)],
);

export const planSteps = pgTable(
  "plan_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    /** move | rename | createFolder | tag | untag | caption | category | trash | restore | flag | unflag | rule_create | rule_update */
    action: text("action").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    before: text("before"),
    after: text("after"),
    /** The file version the plan was made against; a mismatch marks the step conflicted. */
    expectVersion: text("expect_version"),
    /** Undo plans: the audit event this step reverts. */
    undoesEventId: uuid("undoes_event_id"),
    actor: text("actor"),
    status: stepStatus("status").notNull().default("pending"),
    error: text("error"),
  },
  (t) => [uniqueIndex("plan_steps_plan_seq_uq").on(t.planId, t.seq), index("plan_steps_org_idx").on(t.organizationId)],
);

/**
 * Append-only audit log. A database trigger rejects UPDATE and DELETE (see migrations).
 * Undo is recorded as a NEW event whose `undoes_event_id` points at the original;
 * the view `audit_events_with_undo` exposes `undone_by` / `undone_at`.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic order within the whole log (timestamps can tie). */
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    at: ts("at").notNull().defaultNow(),
    organizationId: orgId(),
    /** No foreign key on purpose: removing a space must never have to rewrite (UPDATE) audit rows. */
    spaceId: uuid("space_id"),
    /** user:<id> | agent:<user> | rule:<id> | mcp:<client>:<user> */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    fileIds: uuid("file_ids").array().notNull().default(sql`'{}'::uuid[]`),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    planId: uuid("plan_id"),
    batchId: uuid("batch_id"),
    undoesEventId: uuid("undoes_event_id").references((): AnyPgColumn => auditEvents.id),
  },
  (t) => [
    index("audit_org_at_idx").on(t.organizationId, t.at),
    index("audit_batch_idx").on(t.batchId),
    index("audit_plan_idx").on(t.planId),
    index("audit_undoes_idx").on(t.undoesEventId),
    index("audit_space_at_idx").on(t.spaceId, t.at),
  ],
);

export const trashItems = pgTable(
  "trash_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    originalPath: text("original_path").notNull(),
    originalParentRef: text("original_parent_ref"),
    trashedBy: text("trashed_by").notNull(),
    trashedAt: ts("trashed_at").notNull().defaultNow(),
    /** Retention: default 30 days, configurable (§2). */
    purgeAfter: ts("purge_after").notNull(),
    restoredAt: ts("restored_at"),
  },
  (t) => [index("trash_org_idx").on(t.organizationId), index("trash_purge_idx").on(t.purgeAfter)],
);

/** Cloud-mode share links. Tokens and passwords are stored hashed. */
export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    permission: sharePermission("permission").notNull().default("view"),
    passwordHash: text("password_hash"),
    expiresAt: ts("expires_at"),
    downloadCount: integer("download_count").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("shares_org_idx").on(t.organizationId)],
);

/** MCP/API keys: only a hash and a short display prefix are stored. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: ts("last_used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_keys_org_idx").on(t.organizationId)],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    at: ts("at").notNull().defaultNow(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").$type<"analysis" | "agent" | "embedding">().notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    files: integer("files").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("ai_usage_org_at_idx").on(t.organizationId, t.at)],
);

export interface OrgThresholds {
  nearDuplicateDistance: number;
  blur: number;
  dark: number;
  tiny: number;
  confidence: number;
}

/**
 * One row per organization: AI provider (non-secret part as JSON, secrets AES-256-GCM encrypted),
 * analysis thresholds and the monthly AI file budget.
 */
export const orgSettings = pgTable("org_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ai: jsonb("ai").$type<Record<string, unknown>>().notNull().default({}),
  aiSecretsEncrypted: text("ai_secrets_encrypted"),
  thresholds: jsonb("thresholds").$type<Partial<OrgThresholds>>().notNull().default({}),
  aiMonthlyFileBudget: integer("ai_monthly_file_budget").notNull().default(1000),
  /** Admins may let small agent/MCP plans run without approval (spec §2). Default: never. */
  autoRun: jsonb("auto_run").$type<Partial<AutoRunSettings>>().notNull().default({}),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Every agent tool call (spec §9: "every tool call logged"). Input is a short summary without file contents.
 * Separate from the audit log, which records changes.
 */
export const agentToolCalls = pgTable(
  "agent_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    /** Who the agent acted for (agent:<userId> in the audit log). */
    userId: text("user_id").notNull(),
    spaceId: uuid("space_id"),
    /** "agent" (FolderPilot chat) or "mcp:<client>" later. */
    via: text("via").notNull().default("agent"),
    conversationId: text("conversation_id"),
    tool: text("tool").notNull(),
    input: text("input").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("agent_tool_calls_org_at_idx").on(t.organizationId, t.at)],
);

/** Same content + same provider/model = same insight: never pay for analyzing a file twice. */
export const aiInsightCache = pgTable(
  "ai_insight_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    sha256: text("sha256").notNull(),
    cacheKey: text("cache_key").notNull(),
    model: text("model").notNull(),
    insight: jsonb("insight").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_cache_org_sha_key_uq").on(t.organizationId, t.sha256, t.cacheKey)],
);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: orgId().unique(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  seats: integer("seats").notNull().default(1),
  currentPeriodEnd: ts("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: ts("read_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.organizationId, t.userId, t.createdAt)],
);

/**
 * Settings of this FolderPilot server (not of one organization), e.g. the Google OAuth client an admin pasted in
 * the app. Values are AES-256-GCM encrypted, bound to their key.
 */
export const serverSettings = pgTable("server_settings", {
  key: text("key").primaryKey(),
  valueEncrypted: text("value_encrypted").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
