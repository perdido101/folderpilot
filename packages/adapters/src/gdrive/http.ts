/**
 * Google API HTTP layer: bearer tokens refreshed automatically (before expiry and on 401), exponential backoff with
 * jitter on rate limits and 5xx, and errors mapped to storage errors.
 */
import { NotFoundError, StorageError } from "@folderpilot/core";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  /** Defaults to Google's token endpoint (tests point it at a mock). */
  tokenUrl?: string;
}

/** The connection can't be used any more (access revoked, refresh token expired): the person has to reconnect. */
export class DriveAuthError extends StorageError {
  constructor(message = "Google Drive access was revoked or has expired. Reconnect the space to continue.") {
    super(message, "provider");
    this.name = "DriveAuthError";
  }
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function refreshAccessToken(client: GoogleClient, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<GoogleTokens> {
  const res = await fetchImpl(client.tokenUrl ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    if (body.error === "invalid_grant" || res.status === 400 || res.status === 401) throw new DriveAuthError();
    throw new StorageError(`Google sign-in refresh failed (${res.status}).`, "provider");
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

export interface HttpOptions {
  client: GoogleClient;
  tokens: GoogleTokens;
  /** Called whenever tokens are refreshed (persist them, encrypted). */
  onTokens?: (tokens: GoogleTokens) => void | Promise<void>;
  maxTries?: number;
  /** Base backoff in ms (tests use 1). */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GoogleHttp {
  private tokens: GoogleTokens;
  private refreshing: Promise<void> | null = null;
  constructor(private readonly opts: HttpOptions) {
    this.tokens = opts.tokens;
  }

  private async refresh() {
    this.refreshing ??= (async () => {
      try {
        this.tokens = await refreshAccessToken(this.opts.client, this.tokens.refreshToken, this.opts.fetchImpl);
        await this.opts.onTokens?.(this.tokens);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** A raw authorized request with retries. Throws mapped errors for non-2xx. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    const max = this.opts.maxTries ?? 5;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      if (this.tokens.expiresAt - Date.now() < 60_000) await this.refresh();
      let res: Response;
      try {
        res = await f(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.tokens.accessToken}` } });
      } catch (err) {
        if (attempt >= max) throw new StorageError(`Google Drive can't be reached: ${err instanceof Error ? err.message : String(err)}`, "provider");
        await sleep(this.delay(attempt));
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.refresh();
        continue;
      }
      const text = await res.text().catch(() => "");
      const reason = (() => {
        try {
          return (JSON.parse(text) as { error?: { errors?: { reason?: string }[]; message?: string } }).error;
        } catch {
          return undefined;
        }
      })();
      const rateLimited = res.status === 403 && reason?.errors?.some((e) => e.reason === "rateLimitExceeded" || e.reason === "userRateLimitExceeded");
      if ((RETRY_STATUS.has(res.status) || rateLimited) && attempt < max) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : this.delay(attempt));
        continue;
      }
      if (res.status === 401) throw new DriveAuthError();
      if (res.status === 404) throw new NotFoundError(reason?.message ?? "Not found in Google Drive.");
      throw new StorageError(`Google Drive error ${res.status}: ${reason?.message ?? text.slice(0, 200)}`, "provider");
    }
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }

  private delay(attempt: number) {
    const base = this.opts.backoffMs ?? 500;
    return base * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
  }
}
