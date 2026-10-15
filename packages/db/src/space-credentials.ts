/**
 * Provider credentials of a space (Connect mode), AES-256-GCM encrypted and bound to the space id (AAD), so a
 * ciphertext copied to another space can't be opened. Never returned to the browser.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { decrypt, encrypt } from "./crypto";
import { spaces } from "./schema";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface SpaceCredentials {
  kind: "oauth";
  tokens: OAuthTokens;
}

const aad = (spaceId: string) => `space:${spaceId}`;

export function sealCredentials(key: Buffer, spaceId: string, creds: SpaceCredentials): string {
  return encrypt(JSON.stringify(creds), key, aad(spaceId));
}

export function openCredentials(key: Buffer, space: { id: string; credentialsEncrypted: string | null }): SpaceCredentials | null {
  if (!space.credentialsEncrypted) return null;
  return JSON.parse(decrypt(space.credentialsEncrypted, key, aad(space.id))) as SpaceCredentials;
}

/** Save refreshed tokens (and clear a "needs reconnect" mark). */
export async function saveSpaceTokens(db: Database, key: Buffer, spaceId: string, tokens: OAuthTokens) {
  await db
    .update(spaces)
    .set({ credentialsEncrypted: sealCredentials(key, spaceId, { kind: "oauth", tokens }), settings: sql`${spaces.settings} - 'needsReconnect'`, updatedAt: new Date() })
    .where(eq(spaces.id, spaceId));
}

/** The provider no longer accepts our credentials: show "Reconnect" for this space. */
export async function markNeedsReconnect(db: Database, spaceId: string, reason: string) {
  await db
    .update(spaces)
    .set({ settings: sql`jsonb_set(${spaces.settings}, '{needsReconnect}', to_jsonb(${reason}::text))`, updatedAt: new Date() })
    .where(eq(spaces.id, spaceId));
}
