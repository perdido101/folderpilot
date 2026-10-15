import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterId, StorageAdapter } from "@folderpilot/core";
import { LocalServerAdapter } from "./local-server";
import { GoogleDriveAdapter, type GoogleTokens } from "./gdrive";

export interface SpaceRef {
  id?: string;
  adapterId: AdapterId;
  rootRef: string;
  credentialsEncrypted?: string | null;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl?: string | undefined;
  apiBase?: string | undefined;
}

export interface RegistryOptions {
  /** FP_DEV_SAMPLE_DIR: a server folder allowed in development and tests only. */
  devSampleDir?: string | undefined;
  production: boolean;
  /** GOOGLE_CLIENT_ID/SECRET (null/undefined = Google Drive isn't configured on this server). */
  google?: GoogleConfig | null;
  /** Opens a space's encrypted credentials and saves refreshed tokens. */
  credentials?: {
    open(space: SpaceRef): { tokens: GoogleTokens } | null;
    save(space: SpaceRef, tokens: GoogleTokens): Promise<void>;
  };
  /** Base backoff for provider retries (tests use 1 ms). */
  backoffMs?: number;
}

export class AdapterUnavailableError extends Error {}

const ARRIVES: Partial<Record<AdapterId, string>> = {
  "fp-cloud": "FolderPilot Cloud arrives in phase 7.",
  onedrive: "OneDrive/SharePoint arrives in phase 8.",
  dropbox: "Dropbox arrives in phase 8.",
  "local-server": "Server folders arrive with Private mode in phase 9.",
  "local-browser": "Folders on this device are handled in the browser, not on the server.",
};

// Adapters keep useful state (Drive's folder-path cache, fresh tokens): reuse them per space while nothing changes.
const cache = new Map<string, StorageAdapter>();

/** The StorageAdapter for a space on the server (worker and API). */
export function adapterForSpace(space: SpaceRef, opts: RegistryOptions): StorageAdapter {
  if (space.adapterId === "local-server" && !opts.production && opts.devSampleDir) {
    const allowed = path.resolve(opts.devSampleDir);
    if (path.resolve(space.rootRef) === allowed) return new LocalServerAdapter(allowed);
  }
  if (space.adapterId === "gdrive") {
    if (!opts.google) throw new AdapterUnavailableError("Google Drive isn't set up on this server yet (an admin can do it in Admin → Google Drive).");
    if (!space.rootRef) throw new AdapterUnavailableError("Choose which Google Drive folder this space should organize first.");
    const creds = opts.credentials?.open(space);
    if (!creds) throw new AdapterUnavailableError("This Google Drive space isn't connected. Reconnect it.");
    // New tokens, another folder or another Google client (an admin replaced the keys) = a fresh adapter.
    const key = `${space.id}|${space.rootRef}|${opts.google.clientId}|${createHash("sha256").update(creds.tokens.refreshToken).digest("hex").slice(0, 16)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const google = opts.google;
    const adapter = new GoogleDriveAdapter({
      rootId: space.rootRef,
      client: { clientId: google.clientId, clientSecret: google.clientSecret, ...(google.tokenUrl ? { tokenUrl: google.tokenUrl } : {}) },
      tokens: creds.tokens,
      onTokens: (t) => opts.credentials?.save(space, t),
      ...(google.apiBase ? { apiBase: google.apiBase } : {}),
      ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}),
    });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(key, adapter);
    return adapter;
  }
  throw new AdapterUnavailableError(ARRIVES[space.adapterId] ?? `Unknown adapter ${space.adapterId}.`);
}
