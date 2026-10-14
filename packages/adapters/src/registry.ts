import path from "node:path";
import type { AdapterId, StorageAdapter } from "@folderpilot/core";
import { LocalServerAdapter } from "./local-server";

export interface SpaceRef {
  adapterId: AdapterId;
  rootRef: string;
}

export interface RegistryOptions {
  /** FP_DEV_SAMPLE_DIR: the only server folder allowed in phase 3 (development and tests only). */
  devSampleDir?: string | undefined;
  production: boolean;
}

export class AdapterUnavailableError extends Error {}

const ARRIVES: Partial<Record<AdapterId, string>> = {
  "fp-cloud": "FolderPilot Cloud arrives in phase 7.",
  gdrive: "Google Drive arrives in phase 8.",
  onedrive: "OneDrive/SharePoint arrives in phase 8.",
  dropbox: "Dropbox arrives in phase 8.",
  "local-server": "Server folders arrive with Private mode in phase 9.",
  "local-browser": "Folders on this device are handled in the browser, not on the server.",
};

/** The StorageAdapter for a space on the server (worker and API). */
export function adapterForSpace(space: SpaceRef, opts: RegistryOptions): StorageAdapter {
  if (space.adapterId === "local-server" && !opts.production && opts.devSampleDir) {
    const allowed = path.resolve(opts.devSampleDir);
    if (path.resolve(space.rootRef) === allowed) return new LocalServerAdapter(allowed);
  }
  throw new AdapterUnavailableError(ARRIVES[space.adapterId] ?? `Unknown adapter ${space.adapterId}.`);
}
