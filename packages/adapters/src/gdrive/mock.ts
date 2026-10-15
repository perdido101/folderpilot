/**
 * An in-memory Google Drive + Google OAuth server for tests and the E2E suite. Implements the subset FolderPilot uses
 * (files list/get/media/export/update/create, changes feed, about, token/refresh/revoke, a consent page).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";

export interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content?: string;
  modifiedTime: string;
  trashed: boolean;
}

const FOLDER = "application/vnd.google-apps.folder";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export class MockGoogle {
  readonly files = new Map<string, MockFile>();
  readonly calls: { method: string; path: string }[] = [];
  /** fileIds in order of change; the page token is an index into it. */
  private changeLog: string[] = [];
  private codes = new Map<string, { challenge: string; redirect: string }>();
  readonly accessTokens = new Set<string>();
  readonly refreshTokens = new Set<string>();
  readonly revoked: string[] = [];
  /** Fail the next N Drive calls with this status (rate-limit tests). */
  failNext: { status: number; count: number } | null = null;
  /** Issued access tokens expire after this many seconds. */
  tokenLifetime = 3600;
  account = { emailAddress: "you@example.com", displayName: "Test User" };
  /** When set, the token endpoint refuses other client ids/secrets (invalid_client), like Google. */
  client: { id: string; secret: string } | null = null;
  private server: http.Server | null = null;
  base = "";

  constructor() {
    this.files.set("root-id", { id: "root-id", name: "My Drive", mimeType: FOLDER, parents: [], modifiedTime: new Date().toISOString(), trashed: false });
  }

  // ── Test helpers ────────────────────────────────────────────────────────
  addFolder(name: string, parent = "root-id", id = randomUUID()): string {
    this.files.set(id, { id, name, mimeType: FOLDER, parents: [parent], modifiedTime: new Date().toISOString(), trashed: false });
    this.changeLog.push(id);
    return id;
  }
  addFile(name: string, content: string, parent = "root-id", opts: { mimeType?: string; id?: string } = {}): string {
    const id = opts.id ?? randomUUID();
    this.files.set(id, { id, name, mimeType: opts.mimeType ?? "text/plain", parents: [parent], content, modifiedTime: new Date().toISOString(), trashed: false });
    this.changeLog.push(id);
    return id;
  }
  edit(id: string, patch: Partial<MockFile>) {
    const f = this.files.get(id)!;
    Object.assign(f, patch, patch.content !== undefined ? { modifiedTime: new Date(Date.now() + 1000).toISOString() } : {});
    this.changeLog.push(id);
  }
  remove(id: string) {
    this.files.delete(id);
    this.changeLog.push(id);
  }
  /** Path of a file from My Drive ("A/b.txt"), for assertions. */
  pathOf(id: string): string {
    const parts: string[] = [];
    let f = this.files.get(id);
    while (f && f.id !== "root-id") {
      parts.unshift(f.name);
      f = this.files.get(f.parents[0] ?? "");
    }
    return parts.join("/");
  }
  byPath(path: string): MockFile | undefined {
    return [...this.files.values()].find((f) => !f.trashed && this.pathOf(f.id) === path);
  }
  /** Issue tokens directly (unit tests that skip the consent flow). */
  issueTokens() {
    const access = `at_${randomUUID()}`;
    const refresh = `rt_${randomUUID()}`;
    this.accessTokens.add(access);
    this.refreshTokens.add(refresh);
    return { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + this.tokenLifetime * 1000 };
  }

  // ── Server ──────────────────────────────────────────────────────────────
  async start(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }
  stop() {
    return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
  get urls() {
    return { authUrl: `${this.base}/o/oauth2/v2/auth`, tokenUrl: `${this.base}/token`, revokeUrl: `${this.base}/revoke`, apiBase: `${this.base}/drive/v3` };
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
  private view(f: MockFile) {
    const binary = f.mimeType !== FOLDER && !f.mimeType.startsWith("application/vnd.google-apps.");
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      modifiedTime: f.modifiedTime,
      trashed: f.trashed,
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
      ...(binary ? { size: String(Buffer.byteLength(f.content ?? "")), md5Checksum: md5(f.content ?? ""), thumbnailLink: `${this.base}/thumb/${f.id}=s220` } : {}),
    };
  }

  private async body(req: http.IncomingMessage): Promise<string> {
    let raw = "";
    for await (const c of req) raw += (c as Buffer).toString();
    return raw;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    const raw = await this.body(req);
    this.calls.push({ method: req.method ?? "GET", path: url.pathname });

    // OAuth
    if (url.pathname === "/o/oauth2/v2/auth") {
      // The consent screen: approves at once (or refuses with ?deny via login_hint "deny").
      const redirect = url.searchParams.get("redirect_uri")!;
      const state = url.searchParams.get("state")!;
      if (url.searchParams.get("login_hint") === "deny") {
        res.writeHead(302, { location: `${redirect}?error=access_denied&state=${encodeURIComponent(state)}` });
        return res.end();
      }
      const code = `code_${randomUUID()}`;
      this.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(state)}` });
      return res.end();
    }
    if (url.pathname === "/token") {
      const p = new URLSearchParams(raw);
      if (this.client && (p.get("client_id") !== this.client.id || p.get("client_secret") !== this.client.secret)) return this.json(res, 401, { error: "invalid_client" });
      if (p.get("grant_type") === "authorization_code") {
        const c = this.codes.get(p.get("code") ?? "");
        const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.challenge !== challenge || c.redirect !== p.get("redirect_uri")) return this.json(res, 400, { error: "invalid_grant" });
        this.codes.delete(p.get("code")!);
        const t = this.issueTokens();
        return this.json(res, 200, { access_token: t.accessToken, refresh_token: t.refreshToken, expires_in: this.tokenLifetime, scope: "openid email https://www.googleapis.com/auth/drive", token_type: "Bearer" });
      }
      if (p.get("grant_type") === "refresh_token") {
        if (!this.refreshTokens.has(p.get("refresh_token") ?? "")) return this.json(res, 400, { error: "invalid_grant" });
        const access = `at_${randomUUID()}`;
        this.accessTokens.add(access);
        return this.json(res, 200, { access_token: access, expires_in: this.tokenLifetime });
      }
      return this.json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke") {
      const token = new URLSearchParams(raw).get("token") ?? "";
      this.revoked.push(token);
      this.refreshTokens.delete(token);
      this.accessTokens.delete(token);
      return this.json(res, 200, {});
    }
    if (url.pathname.startsWith("/thumb/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from("thumb"));
    }

    // Drive API
    if (!url.pathname.startsWith("/drive/v3")) return this.json(res, 404, { error: { message: "not found" } });
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.accessTokens.has(token)) return this.json(res, 401, { error: { message: "Invalid Credentials" } });
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      return this.json(res, this.failNext.status, { error: { message: "Rate Limit Exceeded", errors: [{ reason: "userRateLimitExceeded" }] } });
    }
    const path = url.pathname.slice("/drive/v3".length);
    const get = (id: string) => (id === "root" ? this.files.get("root-id") : this.files.get(id));

    if (path === "/about") return this.json(res, 200, { user: this.account });
    if (path === "/changes/startPageToken") return this.json(res, 200, { startPageToken: String(this.changeLog.length) });
    if (path === "/changes") {
      const from = Number(url.searchParams.get("pageToken"));
      if (!Number.isInteger(from) || from > this.changeLog.length) return this.json(res, 400, { error: { message: "Invalid page token" } });
      const ids = [...new Set(this.changeLog.slice(from))];
      return this.json(res, 200, {
        changes: ids.map((fileId) => {
          const f = this.files.get(fileId);
          return f ? { fileId, removed: false, file: this.view(f) } : { fileId, removed: true };
        }),
        newStartPageToken: String(this.changeLog.length),
      });
    }
    if (path === "/files" && req.method === "GET") {
      const qs = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(qs)?.[1];
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(qs)?.[1]?.replace(/\\(.)/g, "$1");
      const onlyFolders = qs.includes(`mimeType = '${FOLDER}'`);
      const list = [...this.files.values()].filter((f) => f.id !== "root-id" && !f.trashed && (!parent || f.parents.includes(parent === "root" ? "root-id" : parent)) && (name === undefined || f.name === name) && (!onlyFolders || f.mimeType === FOLDER));
      return this.json(res, 200, { files: list.map((f) => this.view(f)) });
    }
    if (path === "/files" && req.method === "POST") {
      const b = JSON.parse(raw) as { name: string; mimeType: string; parents: string[] };
      const id = this.addFolder(b.name, b.parents[0]);
      return this.json(res, 200, this.view(this.files.get(id)!));
    }
    const m = /^\/files\/([^/]+)(\/export)?$/.exec(path);
    if (m) {
      const f = get(decodeURIComponent(m[1]!));
      if (!f) return this.json(res, 404, { error: { message: `File not found: ${m[1]}` } });
      if (m[2]) {
        res.writeHead(200, { "content-type": url.searchParams.get("mimeType") ?? "text/plain" });
        return res.end(f.content ?? "");
      }
      if (req.method === "PATCH") {
        const b = JSON.parse(raw || "{}") as { name?: string; trashed?: boolean };
        if (b.name !== undefined) f.name = b.name;
        if (b.trashed !== undefined) f.trashed = b.trashed;
        const add = url.searchParams.get("addParents");
        const remove = url.searchParams.get("removeParents");
        if (remove) f.parents = f.parents.filter((p) => !remove.split(",").includes(p));
        if (add) f.parents = [...new Set([...f.parents, ...add.split(",")])];
        this.changeLog.push(f.id);
        return this.json(res, 200, this.view(f));
      }
      if (url.searchParams.get("alt") === "media") {
        res.writeHead(200, { "content-type": f.mimeType });
        return res.end(f.content ?? "");
      }
      return this.json(res, 200, this.view(f));
    }
    return this.json(res, 404, { error: { message: "unknown endpoint" } });
  }
}
