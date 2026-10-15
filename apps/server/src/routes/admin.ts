/**
 * Server-wide setup in the app (Admin → Google Drive): the Google OAuth client for Drive, with the exact addresses to
 * paste into Google Cloud. Only the server admin (FP_ADMIN_EMAILS, else the first account) may change it; keys set in
 * the environment always win and can't be changed here. The client secret is never returned.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { checkClient } from "@folderpilot/adapters";
import { clearGoogleOAuth, isServerAdmin, saveGoogleOAuth } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireUser } from "../middleware/auth";

export function adminRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const adminEmails = (deps.env.FP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const base = deps.env.API_URL.replace(/\/$/, "");
  const addresses = () => ({
    origin: new URL(deps.env.APP_URL).origin,
    redirectUris: [`${base}/api/connect/gdrive/callback`, `${base}/api/auth/callback/google`],
  });
  const mustBeAdmin = async (user: { id: string; email: string }) => {
    if (!(await isServerAdmin(deps.db, user, adminEmails))) throw new HTTPException(403, { message: "Only the person who set up this FolderPilot server can change this." });
  };

  app.get("/google", requireUser, async (c) => {
    const user = c.get("user")!;
    const admin = await isServerAdmin(deps.db, user, adminEmails);
    const g = deps.google.current();
    return c.json({
      isServerAdmin: admin,
      configured: Boolean(g),
      source: g?.source ?? null,
      clientId: admin ? (g?.clientId ?? null) : null,
      ...addresses(),
    });
  });

  app.put("/google", requireUser, async (c) => {
    const user = c.get("user")!;
    await mustBeAdmin(user);
    if (deps.google.current()?.source === "env") throw new HTTPException(409, { message: "The Google keys are set in this server's environment (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET); change them there." });
    const body = z
      .object({
        clientId: z
          .string()
          .trim()
          .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, "The Client ID ends with .apps.googleusercontent.com — copy it from Google Cloud → Clients."),
        clientSecret: z.string().trim().min(10, "Paste the Client secret from Google Cloud → Clients.").max(200),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HTTPException(400, { message: body.error.issues[0]?.message ?? "Invalid request." });
    const check = await checkClient({ clientId: body.data.clientId, clientSecret: body.data.clientSecret, ...(deps.env.GOOGLE_TOKEN_URL ? { tokenUrl: deps.env.GOOGLE_TOKEN_URL } : {}) }, addresses().redirectUris[0]!);
    if (check === "invalid") throw new HTTPException(400, { message: "Google doesn't recognize this Client ID and secret. Copy both again from Google Cloud → Clients (the secret starts with GOCSPX-)." });
    await saveGoogleOAuth(deps.db, deps.encryptionKey, body.data, user.id);
    await deps.google.refresh();
    deps.log.info({ userId: user.id, verified: check === "ok" }, "google drive keys saved in the app");
    return c.json({ ok: true, verified: check === "ok", configured: Boolean(deps.google.current()) });
  });

  app.delete("/google", requireUser, async (c) => {
    const user = c.get("user")!;
    await mustBeAdmin(user);
    if (deps.google.current()?.source === "env") throw new HTTPException(409, { message: "The Google keys are set in this server's environment; remove them there." });
    await clearGoogleOAuth(deps.db);
    await deps.google.refresh();
    deps.log.info({ userId: user.id }, "google drive keys removed in the app");
    return c.json({ ok: true });
  });

  return app;
}
