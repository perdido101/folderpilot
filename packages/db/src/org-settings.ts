/**
 * Per-organization AI settings, thresholds and budget. Secret fields (API keys, Bedrock keys, Vertex service account)
 * are stored AES-256-GCM encrypted (bound to the org id) and never returned to the browser.
 */
import { AI_SECRET_FIELDS, withDefaults, type AISettings } from "@folderpilot/ai";
import { DEFAULT_THRESHOLDS, type AutoRunSettings, type Thresholds } from "@folderpilot/core";
import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { decrypt, encrypt } from "./crypto";
import { orgSettings } from "./schema";

export type SecretField = (typeof AI_SECRET_FIELDS)[number];

export interface OrgSettings {
  ai: AISettings;
  thresholds: Thresholds;
  aiMonthlyFileBudget: number;
  /** Small agent/MCP plans that may run without approval (default: none). */
  autoRun: AutoRunSettings;
}

export const DEFAULT_AUTO_RUN: AutoRunSettings = { maxFiles: 0, allowMcp: false };

/** What the browser may see: secrets replaced by whether they are set. */
export interface PublicOrgSettings extends OrgSettings {
  secretsSet: Record<SecretField, boolean>;
}

export const DEFAULT_AI_MONTHLY_FILE_BUDGET = 1000;

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[keys.at(-1)!] = value;
}

/** Split secrets out of the settings (for storage) — the remaining object has empty strings in their place. */
function splitSecrets(ai: AISettings): { plain: AISettings; secrets: Partial<Record<SecretField, string>> } {
  const plain = structuredClone(ai);
  const secrets: Partial<Record<SecretField, string>> = {};
  for (const f of AI_SECRET_FIELDS) {
    const v = getPath(plain, f);
    if (typeof v === "string" && v) secrets[f] = v;
    setPath(plain as unknown as Record<string, unknown>, f, "");
  }
  return { plain, secrets };
}

export async function loadOrgSettings(db: Database, orgId: string, key: Buffer): Promise<OrgSettings> {
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.organizationId, orgId)).limit(1);
  const ai = withDefaults(row?.ai as Partial<AISettings> | undefined);
  if (row?.aiSecretsEncrypted) {
    const secrets = JSON.parse(decrypt(row.aiSecretsEncrypted, key, `org-ai:${orgId}`)) as Partial<Record<SecretField, string>>;
    for (const [f, v] of Object.entries(secrets)) setPath(ai as unknown as Record<string, unknown>, f, v);
  }
  return {
    ai,
    thresholds: { ...DEFAULT_THRESHOLDS, ...row?.thresholds },
    aiMonthlyFileBudget: row?.aiMonthlyFileBudget ?? DEFAULT_AI_MONTHLY_FILE_BUDGET,
    autoRun: { ...DEFAULT_AUTO_RUN, ...row?.autoRun },
  };
}

export function toPublic(s: OrgSettings): PublicOrgSettings {
  const { plain, secrets } = splitSecrets(s.ai);
  const secretsSet = Object.fromEntries(AI_SECRET_FIELDS.map((f) => [f, Boolean(secrets[f])])) as Record<SecretField, boolean>;
  return { ...s, ai: plain, secretsSet };
}

/**
 * Save settings from the browser. A secret sent as "" keeps the stored value (the browser never has it);
 * `clearSecrets` removes specific ones.
 */
export async function saveOrgSettings(
  db: Database,
  orgId: string,
  key: Buffer,
  next: { ai: AISettings; thresholds: Thresholds; aiMonthlyFileBudget: number; autoRun?: AutoRunSettings },
  clearSecrets: SecretField[] = [],
): Promise<OrgSettings> {
  const current = await loadOrgSettings(db, orgId, key);
  const { secrets: existing } = splitSecrets(current.ai);
  const { plain, secrets: incoming } = splitSecrets(next.ai);
  const merged: Partial<Record<SecretField, string>> = { ...existing, ...incoming };
  for (const f of clearSecrets) delete merged[f];
  const aiSecretsEncrypted = Object.keys(merged).length ? encrypt(JSON.stringify(merged), key, `org-ai:${orgId}`) : null;
  const values = { ai: plain as unknown as Record<string, unknown>, aiSecretsEncrypted, thresholds: next.thresholds, aiMonthlyFileBudget: next.aiMonthlyFileBudget, autoRun: next.autoRun ?? current.autoRun, updatedAt: new Date() };
  await db
    .insert(orgSettings)
    .values({ organizationId: orgId, ...values })
    .onConflictDoUpdate({ target: orgSettings.organizationId, set: values });
  return loadOrgSettings(db, orgId, key);
}
