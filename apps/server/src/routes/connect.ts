/**
 * Connect mode (spec §4): connect a Google Drive with OAuth (PKCE, single-use state), choose the folder FolderPilot
 * organizes, rename, reconnect, disconnect. Tokens are stored encrypted per space and never returned.
 * Disconnecting removes the space from FolderPilot and revokes our access — it never touches files in Drive.
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, eq, type SQL } from "drizzle-orm";
import { consentUrl, exchangeCode, GoogleDriveAdapter, OAuthError, pkcePair, revokeToken, type GoogleTokens } from "@folderpilot/adapters";
import { files, openCredentials, scoped, sealCredentials, spaces } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireOrg, requirePermission } from "../middleware/auth";

interface PendingConnect {
  orgId: string;
  userId: string;
  verifier: string;
  /** Reconnecting an existing space keeps it (and its index). */
  spaceId?: string;
}

const STATE_TTL_SEC = 600;
const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

export function connectRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  // Redis keeps the single-use state; a small in-memory map covers dev without Redis.
  const memory = new Map<string, { value: PendingConnect; until: number }>();
  const putState = async (state: string, value: PendingConnect) => {
    try {
      if (!deps.redis) throw new Error("no redis");
      await deps.redis.set(`gconnect:${state}`, JSON.stringify(value), "EX", STATE_TTL_SEC);
    } catch {
      memory.set(state, { value, until: Date.now() + STATE_TTL_SEC * 1000 });
    }
  };
  const takeState = async (state: string): Promise<PendingConnect | null> => {
    try {
      const raw = deps.redis ? await deps.redis.getdel(`gconnect:${state}`) : null;
      if (raw) return JSON.parse(raw) as PendingConnect;
    } catch {
      // fall through to memory
    }
    const m = memory.get(state);
    memory.delete(state);
    return m && m.until > Date.now() ? m.value : null;
  };

  const google = () => {
    const g = deps.google.current();
    if (!g) throw new HTTPException(409, { message: "Google Drive isn't set up on this server yet. An admin can set it up in Admin → Google Drive." });
    return g;
  };
  const redirectUri = () => `${deps.env.API_URL.replace(/\/$/, "")}/api/connect/gdrive/callback`;
  const appUrl = (path: string) => `${deps.env.APP_URL.replace(/\/$/, "")}${path}`;

  /** A Drive client for a space's tokens (for the folder picker, before a root folder is chosen). */
  function driveFor(space: typeof spaces.$inferSelect, rootId = "root") {
    const g = google();
    const creds = openCredentials(deps.encryptionKey, space);
    if (!creds) throw new HTTPException(409, { message: "This space isn't connected. Reconnect it." });
    return new GoogleDriveAdapter({
      rootId,
      client: { clientId: g.clientId, clientSecret: g.clientSecret, ...(g.tokenUrl ? { tokenUrl: g.tokenUrl } : {}) },
      tokens: creds.tokens,
      onTokens: async (tokens) => {
        await scoped(deps.db, space.organizationId).update(spaces, eq(spaces.id, space.id), { credentialsEncrypted: sealCredentials(deps.encryptionKey, space.id, { kind: "oauth", tokens }) });
      },
      ...(g.apiBase ? { apiBase: g.apiBase } : {}),
      ...(deps.env.NODE_ENV === "test" ? { backoffMs: 1 } : {}),
    });
  }

  async function spaceOr404(orgId: string, spaceId: string) {
    const space = isUuid(spaceId) ? await scoped(deps.db, orgId).first(spaces, eq(spaces.id, spaceId)) : undefined;
    if (!space) throw new HTTPException(404, { message: "Space not found." });
    return space;
  }

  // ── Start: org members who may add sources (owner/admin) are sent to Google ──
  app.get("/orgs/:orgId/connect/gdrive/start", requireOrg(deps), async (c) => {
    const org = c.get("org");
    const reconnect = c.req.query("spaceId");
    if (reconnect) {
      if (!["owner", "admin"].includes(org.role)) throw new HTTPException(403, { message: "Only owners and admins can reconnect sources." });
      await spaceOr404(org.id, reconnect);
    } else if (!["owner", "admin"].includes(org.role)) {
      throw new HTTPException(403, { message: "Only owners and admins can connect sources." });
    }
    const g = google();
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(24).toString("base64url");
    await putState(state, { orgId: org.id, userId: c.get("user")!.id, verifier, ...(reconnect ? { spaceId: reconnect } : {}) });
    return c.redirect(consentUrl({ clientId: g.clientId, redirectUri: redirectUri(), state, challenge, ...(deps.env.GOOGLE_OAUTH_URL ? { authUrl: deps.env.GOOGLE_OAUTH_URL } : {}) }), 302);
  });

  // ── Callback from Google ──
  app.get("/connect/gdrive/callback", async (c) => {
    const fail = (message: string) => c.redirect(appUrl(`/connect/gdrive/error?message=${encodeURIComponent(message)}`), 302);
    const pending = await takeState(c.req.query("state") ?? "");
    if (!pending) return fail("This connection link expired or was already used. Start again from New → Connect source.");
    const user = c.get("user");
    if (!user || user.id !== pending.userId) return fail("Please sign in to FolderPilot as the person who started connecting Google Drive.");
    if (c.req.query("error")) return fail(c.req.query("error") === "access_denied" ? "Google Drive wasn't connected: access was not allowed." : `Google returned an error: ${c.req.query("error")}`);
    const code = c.req.query("code");
    if (!code) return fail("Google didn't return an authorization code.");
    const g = google();
    let tokens: GoogleTokens;
    try {
      tokens = await exchangeCode({ clientId: g.clientId, clientSecret: g.clientSecret, ...(g.tokenUrl ? { tokenUrl: g.tokenUrl } : {}) }, { code, verifier: pending.verifier, redirectUri: redirectUri() });
    } catch (err) {
      return fail(err instanceof OAuthError ? err.message : "Google sign-in failed. Try again.");
    }
    const s = scoped(deps.db, pending.orgId);
    const seal = (spaceId: string) => sealCredentials(deps.encryptionKey, spaceId, { kind: "oauth", tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt } });

    if (pending.spaceId) {
      const space = await s.first(spaces, eq(spaces.id, pending.spaceId));
      if (!space) return fail("That space no longer exists.");
      const { needsReconnect: _cleared, ...settings } = space.settings;
      await s.update(spaces, eq(spaces.id, space.id), { credentialsEncrypted: seal(space.id), settings, updatedAt: new Date() });
      deps.log.info({ orgId: pending.orgId, spaceId: space.id }, "google drive reconnected");
      return c.redirect(appUrl(`/connect/gdrive/${space.id}?reconnected=1`), 302);
    }

    const space = await s.insert(spaces, { name: "Google Drive", mode: "connect", adapterId: "gdrive", rootRef: "", createdBy: user.id, settings: {} });
    await s.update(spaces, eq(spaces.id, space.id), { credentialsEncrypted: seal(space.id) });
    try {
      const account = await driveFor({ ...space, credentialsEncrypted: seal(space.id) }).account();
      await s.update(spaces, eq(spaces.id, space.id), { name: `Google Drive (${account.email})`, settings: { account: account.email } });
    } catch (err) {
      deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, "couldn't read the Google account name");
    }
    deps.log.info({ orgId: pending.orgId, spaceId: space.id }, "google drive connected");
    return c.redirect(appUrl(`/connect/gdrive/${space.id}`), 302);
  });

  // ── Folder picker ──
  app.get("/orgs/:orgId/spaces/:spaceId/provider-folders", requireOrg(deps), requirePermission("space", "update"), async (c) => {
    const space = await spaceOr404(c.get("org").id, c.req.param("spaceId"));
    if (space.adapterId !== "gdrive") throw new HTTPException(400, { message: "This space has no folders to choose from." });
    const parent = c.req.query("parent") || "root";
    const drive = driveFor(space);
    const [folders, name] = await Promise.all([drive.folders(parent), drive.folderName(parent)]);
    return c.json({ parent, name, folders });
  });

  // ── Rename / choose the folder ──
  app.patch("/orgs/:orgId/spaces/:spaceId", requireOrg(deps), requirePermission("space", "update"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    const body = z.object({ name: z.string().trim().min(1).max(80).optional(), rootRef: z.string().min(1).max(200).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HTTPException(400, { message: body.error.issues[0]?.message ?? "Invalid request." });
    const s = scoped(deps.db, orgId);
    const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: new Date() };
    if (body.data.name) patch.name = body.data.name;
    let rescan = false;
    if (body.data.rootRef && body.data.rootRef !== space.rootRef) {
      if (space.adapterId !== "gdrive") throw new HTTPException(400, { message: "This space's folder can't be changed." });
      const rootName = await driveFor(space).folderName(body.data.rootRef);
      // A different folder is a different set of files: start the index over (the audit log is kept).
      await deps.db.delete(files).where(s.where(files, eq(files.spaceId, space.id)));
      patch.rootRef = body.data.rootRef;
      patch.syncCursor = null;
      patch.settings = { ...space.settings, rootName };
      rescan = true;
    }
    await s.update(spaces, eq(spaces.id, space.id), patch);
    if (rescan && deps.queues) {
      await deps.queues.indexing.add("index", { orgId, spaceId: space.id, withAI: true }, { jobId: `index_${space.id}_${Date.now()}`, removeOnComplete: true, removeOnFail: 100, attempts: 2 });
    }
    const updated = (await s.first(spaces, eq(spaces.id, space.id)))!;
    return c.json({ id: updated.id, name: updated.name, rootRef: updated.rootRef, settings: updated.settings, scanning: rescan && Boolean(deps.queues) });
  });

  // ── Disconnect ──
  app.delete("/orgs/:orgId/spaces/:spaceId", requireOrg(deps), requirePermission("space", "disconnect"), async (c) => {
    const orgId = c.get("org").id;
    const space = await spaceOr404(orgId, c.req.param("spaceId"));
    if (space.mode !== "connect") throw new HTTPException(400, { message: "Only connected sources can be disconnected here." });
    let revoked = false;
    try {
      const creds = openCredentials(deps.encryptionKey, space);
      if (creds) revoked = await revokeToken(creds.tokens.refreshToken, deps.env.GOOGLE_REVOKE_URL ?? undefined);
    } catch {
      revoked = false;
    }
    await deps.db.delete(spaces).where(and(eq(spaces.organizationId, orgId), eq(spaces.id, space.id)) as SQL);
    deps.log.info({ orgId, spaceId: space.id, revoked }, "space disconnected");
    return c.json({ ok: true, revoked });
  });

  return app;
}
