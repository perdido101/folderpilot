/** Thin JSON client for the FolderPilot API (same-origin `/api`, cookies included). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The server can't be reached at all (not running, offline). */
export class OfflineError extends Error {}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`, {
      credentials: "include",
      ...init,
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new OfflineError("Server unreachable");
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new OfflineError(`Server unavailable (${res.status})`);
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.message ?? res.statusText);
  return body as T;
}

export interface Me {
  user: { id: string; email: string; name: string };
  organizations: { id: string; name: string; slug: string; role: "owner" | "admin" | "editor" | "viewer" }[];
  activeOrganizationId: string | null;
}

export interface Features {
  auth: { email: boolean; google: boolean; microsoft: boolean };
  connect: { gdrive: boolean; onedrive: boolean; dropbox: boolean };
  cloudStorage: boolean;
  folderpilotAI: boolean;
  ollama: boolean;
  billing: boolean;
  virusScan: boolean;
  mcpHttp: boolean;
}

export interface ServerSpace {
  id: string;
  name: string;
  mode: "connect" | "cloud" | "private";
  adapterId: string;
  connected: boolean;
  /** The folder this space organizes ("" until one is chosen for a connected drive). */
  rootRef: string;
  /** Connected, but no folder chosen yet (Google Drive right after connecting). */
  needsFolder: boolean;
  /** Why the provider stopped accepting our access (null = fine). */
  needsReconnect: string | null;
  settings: { account?: string; rootName?: string };
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Me["organizations"][number]["role"];
  joinedAt: string;
}
