/**
 * Server-wide settings an admin can change in the app (Admin → Google Drive), stored encrypted in `server_settings`.
 * Environment variables always win: a value set by whoever runs the server can't be replaced from the app.
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "./client";
import { decrypt, encrypt } from "./crypto";
import { serverSettings, users } from "./schema";

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The Google client in use, where it came from, plus the endpoint overrides tests use. */
export interface GoogleOAuthConfig extends GoogleOAuthClient {
  source: "env" | "app";
  tokenUrl?: string | undefined;
  apiBase?: string | undefined;
}

const GOOGLE_KEY = "google_oauth";
const aad = (key: string) => `server:${key}`;

export async function readGoogleOAuth(db: Database, encryptionKey: Buffer): Promise<GoogleOAuthClient | null> {
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, GOOGLE_KEY));
  if (!row) return null;
  const v = JSON.parse(decrypt(row.valueEncrypted, encryptionKey, aad(GOOGLE_KEY))) as GoogleOAuthClient;
  return v.clientId && v.clientSecret ? v : null;
}

export async function saveGoogleOAuth(db: Database, encryptionKey: Buffer, client: GoogleOAuthClient, userId: string): Promise<void> {
  const valueEncrypted = encrypt(JSON.stringify(client), encryptionKey, aad(GOOGLE_KEY));
  await db
    .insert(serverSettings)
    .values({ key: GOOGLE_KEY, valueEncrypted, updatedBy: userId })
    .onConflictDoUpdate({ target: serverSettings.key, set: { valueEncrypted, updatedBy: userId, updatedAt: new Date() } });
}

export async function clearGoogleOAuth(db: Database): Promise<void> {
  await db.delete(serverSettings).where(eq(serverSettings.key, GOOGLE_KEY));
}

/**
 * Who may change server-wide settings: the emails in FP_ADMIN_EMAILS when set, otherwise the person who created
 * the first account on this server (whoever deployed it signs up first).
 */
export async function isServerAdmin(db: Database, user: { id: string; email: string }, adminEmails: string[]): Promise<boolean> {
  if (adminEmails.length) return adminEmails.some((e) => e.toLowerCase() === user.email.toLowerCase());
  const [first] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
  return first?.id === user.id;
}

/**
 * The Google client for Drive: environment first, then what an admin saved in the app. Cached and refreshed in the
 * background so callers can read it synchronously (adapters are built per request/job).
 */
export class GoogleOAuthSource {
  private cached: GoogleOAuthConfig | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: Buffer,
    private readonly env: { GOOGLE_CLIENT_ID?: string | undefined; GOOGLE_CLIENT_SECRET?: string | undefined; GOOGLE_TOKEN_URL?: string | undefined; GOOGLE_DRIVE_API?: string | undefined },
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.cached = this.fromEnv();
  }

  private fromEnv(): GoogleOAuthConfig | null {
    const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = this.env;
    return id && secret ? { clientId: id, clientSecret: secret, source: "env", tokenUrl: this.env.GOOGLE_TOKEN_URL, apiBase: this.env.GOOGLE_DRIVE_API } : null;
  }

  current(): GoogleOAuthConfig | null {
    return this.cached;
  }

  async refresh(): Promise<GoogleOAuthConfig | null> {
    const env = this.fromEnv();
    if (env) return (this.cached = env);
    try {
      const saved = await readGoogleOAuth(this.db, this.encryptionKey);
      this.cached = saved ? { ...saved, source: "app", tokenUrl: this.env.GOOGLE_TOKEN_URL, apiBase: this.env.GOOGLE_DRIVE_API } : null;
    } catch (err) {
      this.onError(err);
    }
    return this.cached;
  }

  /** Re-read every `everyMs` (another process — the worker or another server — may have saved new keys). */
  start(everyMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref();
    return this.refresh();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
