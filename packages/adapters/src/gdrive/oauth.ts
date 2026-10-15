/** Google OAuth for connecting Drive (not sign-in): consent URL with PKCE, code exchange, revoke. */
import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_TOKEN_URL, type GoogleClient, type GoogleTokens } from "./http";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** Full Drive access: organizing existing files (move, rename, trash) needs it. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function consentUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string; authUrl?: string; loginHint?: string }): string {
  const u = new URL(opts.authUrl ?? GOOGLE_AUTH_URL);
  u.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: `openid email ${DRIVE_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  }).toString();
  return u.toString();
}

export class OAuthError extends Error {}

export async function exchangeCode(client: GoogleClient, opts: { code: string; verifier: string; redirectUri: string }, fetchImpl: typeof fetch = fetch): Promise<GoogleTokens & { scope: string }> {
  const res = await fetchImpl(client.tokenUrl ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: opts.code, code_verifier: opts.verifier, redirect_uri: opts.redirectUri, client_id: client.clientId, client_secret: client.clientSecret }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new OAuthError(body.error_description ?? body.error ?? `Google refused the sign-in (${res.status}).`);
  if (!body.refresh_token) throw new OAuthError("Google didn't grant offline access. Remove FolderPilot at myaccount.google.com/permissions and connect again.");
  if (body.scope && !body.scope.split(" ").includes(DRIVE_SCOPE)) throw new OAuthError("Drive access wasn't granted. Connect again and allow access to your Google Drive.");
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, scope: body.scope ?? DRIVE_SCOPE };
}

/** Best effort: tell Google to forget the grant (disconnect). */
export async function revokeToken(token: string, revokeUrl = GOOGLE_REVOKE_URL, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return res.ok;
  } catch {
    return false;
  }
}
