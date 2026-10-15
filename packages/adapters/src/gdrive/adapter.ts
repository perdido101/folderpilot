/**
 * Google Drive (Connect mode, spec §4): organizes files where they live. FolderPilot keeps metadata and an index;
 * writes happen in Drive only for plans a person approved (through the action engine).
 *
 * Drive is id- and parent-based; FolderPilot is path-based. Paths are built by walking parents up to the space root
 * (a chosen folder, or My Drive), with a cache. Files outside the root are ignored.
 * Version = md5 for binary files and modifiedTime for Google Docs/Sheets/Slides: content edits change it, moves and
 * renames don't (the engine's crash recovery relies on that).
 */
import { ConflictError, NotFoundError, StorageError, joinPath, splitPath, type ChangeEvent, type FileEntry, type FileRef, type Page, type StorageAdapter, type WriteOptions } from "@folderpilot/core";
import { GoogleHttp, type GoogleClient, type GoogleTokens } from "./http";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Google-native documents have no binary: they are exported, and get a readable extension in FolderPilot. */
const NATIVE: Record<string, { ext: string; exportAs: string }> = {
  "application/vnd.google-apps.document": { ext: "gdoc", exportAs: "text/plain" },
  "application/vnd.google-apps.spreadsheet": { ext: "gsheet", exportAs: "text/csv" },
  "application/vnd.google-apps.presentation": { ext: "gslides", exportAs: "text/plain" },
};
/** Other google-apps types (forms, shortcuts, maps…) aren't files FolderPilot can organize. */
const isSkippedApp = (mime: string) => mime.startsWith("application/vnd.google-apps.") && mime !== FOLDER_MIME && !NATIVE[mime];

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  trashed?: boolean;
  thumbnailLink?: string;
  webViewLink?: string;
}
const FIELDS = "id,name,mimeType,parents,size,modifiedTime,md5Checksum,trashed,thumbnailLink,webViewLink";

export interface DriveAdapterOptions {
  /** The space root: a folder id, or "root" for all of My Drive. */
  rootId: string;
  client: GoogleClient;
  tokens: GoogleTokens;
  onTokens?: (tokens: GoogleTokens) => void | Promise<void>;
  apiBase?: string;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export class GoogleDriveAdapter implements StorageAdapter {
  readonly id = "gdrive" as const;
  private readonly http: GoogleHttp;
  private readonly api: string;
  private rootIdResolved: string | null = null;
  /** id → name/parent for folders and files seen (paths are built from it). */
  private readonly nodes = new Map<string, { name: string; parent: string | null; folder: boolean }>();

  constructor(private readonly opts: DriveAdapterOptions) {
    this.api = (opts.apiBase ?? DRIVE_API).replace(/\/$/, "");
    this.http = new GoogleHttp({ client: opts.client, tokens: opts.tokens, ...(opts.onTokens ? { onTokens: opts.onTokens } : {}), ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  }

  // ── Drive calls ─────────────────────────────────────────────────────────
  private url(path: string, params: Record<string, string> = {}) {
    const u = new URL(`${this.api}${path}`);
    for (const [k, v] of Object.entries({ supportsAllDrives: "true", ...params })) u.searchParams.set(k, v);
    return u.toString();
  }
  private get(id: string) {
    return this.http.json<DriveFile>(this.url(`/files/${encodeURIComponent(id)}`, { fields: FIELDS }));
  }
  private patch(id: string, body: Record<string, unknown>, params: Record<string, string> = {}) {
    return this.http.json<DriveFile>(this.url(`/files/${encodeURIComponent(id)}`, { fields: FIELDS, ...params }), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  private async children(parentId: string, extra = ""): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.http.json<{ files: DriveFile[]; nextPageToken?: string }>(
        this.url("/files", { q: `${q(parentId)} in parents and trashed = false${extra}`, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000", includeItemsFromAllDrives: "true", ...(pageToken ? { pageToken } : {}) }),
      );
      out.push(...res.files);
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** The real id of the root ("root" is an alias for My Drive). */
  async rootId(): Promise<string> {
    if (!this.rootIdResolved) {
      const root = await this.get(this.opts.rootId);
      this.rootIdResolved = root.id;
      this.nodes.set(root.id, { name: "", parent: null, folder: true });
    }
    return this.rootIdResolved;
  }
  private async parentIdOf(ref: FileRef) {
    return ref.id ? ref.id : this.rootId();
  }

  private remember(f: DriveFile) {
    this.nodes.set(f.id, { name: this.displayName(f), parent: f.parents?.[0] ?? null, folder: f.mimeType === FOLDER_MIME });
  }

  /** Path relative to the root, or null when the file isn't inside it. Fetches unknown ancestors. */
  private async pathOf(f: DriveFile): Promise<string | null> {
    const root = await this.rootId();
    this.remember(f);
    const parts: string[] = [];
    let id: string | null = f.id;
    for (let guard = 0; id && guard < 100; guard++) {
      if (id === root) return parts.reverse().join("/");
      let node = this.nodes.get(id);
      if (!node) {
        try {
          const p = await this.get(id);
          this.remember(p);
          node = this.nodes.get(id)!;
        } catch (err) {
          if (err instanceof NotFoundError) return null; // an ancestor we can't see: outside the root
          throw err;
        }
      }
      parts.push(node.name);
      // Prefer a parent that leads into the root when a file has several.
      id = node.parent;
    }
    return null;
  }

  private displayName(f: DriveFile) {
    const native = NATIVE[f.mimeType];
    return native && !f.name.toLowerCase().endsWith(`.${native.ext}`) ? `${f.name}.${native.ext}` : f.name;
  }
  /** FolderPilot name → Drive name (drop the extension we add to Google Docs). */
  private driveName(f: DriveFile, name: string) {
    const native = NATIVE[f.mimeType];
    return native && name.toLowerCase().endsWith(`.${native.ext}`) ? name.slice(0, -(native.ext.length + 1)) : name;
  }

  private versionOf(f: DriveFile) {
    if (f.mimeType === FOLDER_MIME) return "folder";
    return f.md5Checksum ? `md5:${f.md5Checksum}` : `mod:${f.modifiedTime ?? ""}`;
  }

  private toEntry(f: DriveFile, path: string): FileEntry {
    return {
      ref: { id: f.id },
      path,
      name: this.displayName(f),
      isFolder: f.mimeType === FOLDER_MIME,
      size: Number(f.size ?? 0),
      mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
      version: this.versionOf(f),
      mime: f.mimeType,
      ...(f.webViewLink ? { webUrl: f.webViewLink } : {}),
    };
  }

  private async entryOf(f: DriveFile): Promise<FileEntry | null> {
    if (isSkippedApp(f.mimeType)) return null;
    const path = await this.pathOf(f);
    return path === null || path === "" ? null : this.toEntry(f, path);
  }

  // ── StorageAdapter ──────────────────────────────────────────────────────
  async list(path: string, cursor?: string): Promise<Page<FileEntry>> {
    const folder = path ? await this.resolve(path) : null;
    if (path && (!folder || !folder.isFolder)) throw new NotFoundError(`Folder "${path}" not found in Google Drive.`);
    const parent = folder ? folder.ref.id : await this.rootId();
    const res = await this.http.json<{ files: DriveFile[]; nextPageToken?: string }>(
      this.url("/files", { q: `${q(parent)} in parents and trashed = false`, fields: `nextPageToken,files(${FIELDS})`, pageSize: "200", includeItemsFromAllDrives: "true", ...(cursor ? { pageToken: cursor } : {}) }),
    );
    const items: FileEntry[] = [];
    for (const f of res.files) {
      if (isSkippedApp(f.mimeType)) continue;
      this.remember(f);
      items.push(this.toEntry(f, joinPath(path, this.displayName(f))));
    }
    return { items, ...(res.nextPageToken ? { cursor: res.nextPageToken } : {}) };
  }

  async stat(ref: FileRef): Promise<FileEntry> {
    const f = await this.get(ref.id || (await this.rootId()));
    const path = await this.pathOf(f);
    if (path === null) throw new NotFoundError(`${f.name} is no longer in this space.`);
    return this.toEntry(f, path);
  }

  async resolve(path: string): Promise<FileEntry | null> {
    const parts = path.split("/").filter(Boolean);
    let parent = await this.rootId();
    let found: DriveFile | null = null;
    let soFar = "";
    for (const part of parts) {
      const hits = await this.children(parent, ` and name = ${q(part)}`);
      // Google Docs show with an extension in FolderPilot; match those too.
      const native = hits.length ? hits : (await this.children(parent)).filter((f) => this.displayName(f) === part);
      found = native[0] ?? null;
      if (!found) return null;
      this.remember(found);
      soFar = joinPath(soFar, part);
      parent = found.id;
    }
    return found ? this.toEntry(found, soFar) : null;
  }

  async readThumbnail(ref: FileRef, maxPx: number): Promise<Blob | null> {
    const f = await this.get(ref.id);
    if (!f.thumbnailLink) return null;
    const res = await this.http.request(f.thumbnailLink.replace(/=s\d+$/, `=s${Math.min(maxPx, 1600)}`)).catch(() => null);
    return res ? res.blob() : null;
  }

  async readText(ref: FileRef, maxChars: number): Promise<string | null> {
    const f = await this.get(ref.id);
    const native = NATIVE[f.mimeType];
    if (!native && !/^text\/|json|csv|xml/.test(f.mimeType)) return null;
    const res = await this.http.request(native ? this.url(`/files/${encodeURIComponent(f.id)}/export`, { mimeType: native.exportAs }) : this.url(`/files/${encodeURIComponent(f.id)}`, { alt: "media" }));
    return (await res.text()).slice(0, maxChars);
  }

  async download(ref: FileRef): Promise<ReadableStream<Uint8Array>> {
    const f = await this.get(ref.id);
    const native = NATIVE[f.mimeType];
    if (isSkippedApp(f.mimeType) || f.mimeType === FOLDER_MIME) throw new StorageError(`${f.name} can't be downloaded.`, "provider");
    const res = await this.http.request(native ? this.url(`/files/${encodeURIComponent(f.id)}/export`, { mimeType: native.exportAs }) : this.url(`/files/${encodeURIComponent(f.id)}`, { alt: "media" }));
    if (!res.body) throw new StorageError("Google Drive returned no content.", "provider");
    return res.body;
  }

  private async checked(ref: FileRef, expectVersion: string): Promise<DriveFile> {
    const f = await this.get(ref.id);
    if (this.versionOf(f) !== expectVersion) throw new ConflictError(`${this.displayName(f)} changed in Google Drive since the plan was made.`, this.versionOf(f));
    return f;
  }

  /** Drive allows duplicate names; FolderPilot never overwrites or duplicates: "a.pdf" → "a (2).pdf". */
  private async freeName(parentId: string, name: string, selfId?: string): Promise<string> {
    const taken = new Set((await this.children(parentId)).filter((c) => c.id !== selfId).map((c) => this.displayName(c).toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let i = 2; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  async move(ref: FileRef, newParent: FileRef, opts: WriteOptions & { newName?: string }): Promise<FileEntry> {
    const f = await this.checked(ref, opts.expectVersion);
    const target = await this.parentIdOf(newParent);
    const name = await this.freeName(target, opts.newName ?? this.displayName(f), f.id);
    const removeParents = (f.parents ?? []).filter((p) => p !== target).join(",");
    const updated = await this.patch(f.id, { name: this.driveName(f, name) }, { addParents: target, ...(removeParents ? { removeParents } : {}) });
    return this.stat({ id: updated.id });
  }

  async rename(ref: FileRef, newName: string, opts: WriteOptions): Promise<FileEntry> {
    const f = await this.checked(ref, opts.expectVersion);
    const parent = f.parents?.[0] ?? (await this.rootId());
    const name = await this.freeName(parent, newName, f.id);
    await this.patch(f.id, { name: this.driveName(f, name) });
    return this.stat({ id: f.id });
  }

  async createFolder(parent: FileRef, name: string): Promise<FileEntry> {
    const parentId = await this.parentIdOf(parent);
    const existing = (await this.children(parentId, ` and name = ${q(name)} and mimeType = ${q(FOLDER_MIME)}`))[0];
    const folder =
      existing ??
      (await this.http.json<DriveFile>(this.url("/files", { fields: FIELDS }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      }));
    return this.stat({ id: folder.id });
  }

  /** Into Google Drive's own trash (recoverable there for 30 days, and from FolderPilot). */
  async trash(ref: FileRef, opts: WriteOptions): Promise<FileEntry> {
    const f = await this.checked(ref, opts.expectVersion);
    const path = await this.pathOf(f);
    const trashed = await this.patch(f.id, { trashed: true });
    return this.toEntry(trashed, path ?? this.displayName(f));
  }

  async restore(ref: FileRef, originalPath: string): Promise<FileEntry> {
    const f = await this.get(ref.id);
    if (f.trashed) await this.patch(f.id, { trashed: false });
    const { dir, name } = splitPath(originalPath);
    let parent = await this.rootId();
    for (const part of dir.split("/").filter(Boolean)) parent = (await this.createFolder({ id: parent }, part)).ref.id;
    const current = await this.get(f.id);
    if (current.parents?.[0] !== parent || this.displayName(current) !== name) {
      const free = await this.freeName(parent, name, f.id);
      const removeParents = (current.parents ?? []).filter((p) => p !== parent).join(",");
      await this.patch(f.id, { name: this.driveName(current, free) }, { addParents: parent, ...(removeParents ? { removeParents } : {}) });
    }
    return this.stat({ id: f.id });
  }

  /**
   * No cursor: list everything under the root (breadth-first) and start watching from "now".
   * With a cursor: Drive's change feed since then — edits, moves in/out of the root, trashing, deletion.
   */
  async changes(cursor?: string): Promise<{ entries: ChangeEvent[]; cursor: string; complete?: boolean }> {
    if (cursor) {
      try {
        return await this.changesSince(cursor);
      } catch (err) {
        // An expired or invalid page token: fall back to a full listing.
        const invalidToken = err instanceof NotFoundError || (err instanceof StorageError && /error (400|410)/.test(err.message));
        if (!invalidToken) throw err;
      }
    }
    const start = await this.http.json<{ startPageToken: string }>(this.url("/changes/startPageToken"));
    const entries: ChangeEvent[] = [];
    const queue: { id: string; path: string }[] = [{ id: await this.rootId(), path: "" }];
    while (queue.length) {
      const { id, path } = queue.shift()!;
      for (const f of await this.children(id)) {
        if (isSkippedApp(f.mimeType)) continue;
        this.remember(f);
        const p = joinPath(path, this.displayName(f));
        entries.push({ type: "upsert", entry: this.toEntry(f, p) });
        if (f.mimeType === FOLDER_MIME) queue.push({ id: f.id, path: p });
      }
    }
    return { entries, cursor: start.startPageToken, complete: true };
  }

  private async changesSince(cursor: string): Promise<{ entries: ChangeEvent[]; cursor: string; complete: false }> {
    const entries: ChangeEvent[] = [];
    let pageToken: string | undefined = cursor;
    let next = cursor;
    while (pageToken) {
      const res: { changes: { fileId: string; removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string } = await this.http.json(
        this.url("/changes", { pageToken, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`, pageSize: "1000", includeItemsFromAllDrives: "true" }),
      );
      for (const c of res.changes) {
        if (c.removed || !c.file || c.file.trashed) {
          this.nodes.delete(c.fileId);
          entries.push({ type: "removed", ref: { id: c.fileId } });
          continue;
        }
        const f = c.file;
        const wasFolder = this.nodes.get(f.id)?.folder;
        this.nodes.delete(f.id); // name/parent may have changed
        const entry = await this.entryOf(f);
        if (!entry) {
          entries.push({ type: "removed", ref: { id: f.id } }); // moved out of the root
          continue;
        }
        entries.push({ type: "upsert", entry });
        // A renamed or moved folder changes the paths of everything inside it.
        if (entry.isFolder || wasFolder) {
          const queue = [{ id: f.id, path: entry.path }];
          while (queue.length) {
            const { id, path } = queue.shift()!;
            for (const child of await this.children(id)) {
              if (isSkippedApp(child.mimeType)) continue;
              this.remember(child);
              const p = joinPath(path, this.displayName(child));
              entries.push({ type: "upsert", entry: this.toEntry(child, p) });
              if (child.mimeType === FOLDER_MIME) queue.push({ id: child.id, path: p });
            }
          }
        }
      }
      pageToken = res.nextPageToken;
      if (res.newStartPageToken) next = res.newStartPageToken;
    }
    return { entries, cursor: next, complete: false };
  }

  /** Folders under a parent, for the folder picker ("root" = My Drive). */
  async folders(parentId = "root"): Promise<{ id: string; name: string }[]> {
    const real = parentId === "root" ? (await this.get("root")).id : parentId;
    return (await this.children(real, ` and mimeType = ${q(FOLDER_MIME)}`)).map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Name of a folder (for the space's "root" label). */
  async folderName(id: string): Promise<string> {
    if (id === "root") return "My Drive";
    return (await this.get(id)).name;
  }

  /** The Google account the tokens belong to. */
  async account(): Promise<{ email: string; name: string }> {
    const res = await this.http.json<{ user: { emailAddress: string; displayName: string } }>(this.url("/about", { fields: "user(emailAddress,displayName)" }));
    return { email: res.user.emailAddress, name: res.user.displayName };
  }
}
