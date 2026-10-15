/** Server spaces (files live on a FolderPilot server): typed API calls and React Query hooks. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileFlag, FileStatus } from "@folderpilot/core";
import type { AISettings } from "@folderpilot/ai";
import { api } from "@/lib/api";
import { useActiveOrg, useServerSpaces } from "@/hooks/use-me";
import { useMode } from "@/stores/mode";
import { useUI } from "@/stores/ui";

export interface SpaceFile {
  id: string;
  spaceId: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  status: FileStatus;
  flags: FileFlag[];
  tags: string[];
  category: string | null;
  categorySource: "ai" | "rule" | "user" | null;
  caption: string | null;
  suggestedName: string | null;
  entities: { client?: string; date?: string; amount?: string; docType?: string } | null;
  confidence: number | null;
  aiReason: string | null;
  width: number | null;
  height: number | null;
  blurScore: number | null;
  brightness: number | null;
  sha256: string | null;
  analyzed: boolean;
  aiAnalyzed: boolean;
  flagReason: string | null;
}

export interface SpaceStatus {
  total: number;
  analyzed: number;
  aiAnalyzed: number;
  pendingAnalysis: number;
  needsReview: number;
  flagged: number;
  lastScanAt: number | null;
  scanning: boolean;
  adapter: { readOnly: boolean; error: string | null };
}

export interface DuplicateGroup {
  kind: "exact" | "near";
  keep: SpaceFile;
  others: SpaceFile[];
}

export interface SpaceAuditEvent {
  id: string;
  at: number;
  actor: string;
  action: string;
  fileIds: string[];
  before: string | null;
  after: string | null;
  reason: string | null;
  planId: string | null;
  batchId: string | null;
  undoesEventId: string | null;
  undoneBy: string | null;
  undoneAt: number | null;
}

export interface ReviewResult {
  planId?: string;
  /** After "Set category": what to pre-fill in "Make this a rule?". */
  ruleHint?: { category: string; ext: string; folder: string; docType: string | null } | null;
  batchId: string | null;
  done: number;
  failed: number;
  conflicted: number;
  errors: string[];
}

export type ReviewAction = { action: "accept" | "keep" | "trash"; fileIds: string[] } | { action: "set_category"; fileIds: string[]; category: string };

export interface OrgAISettings {
  settings: {
    ai: AISettings;
    thresholds: { nearDuplicateDistance: number; blur: number; dark: number; tiny: number; confidence: number };
    aiMonthlyFileBudget: number;
    autoRun?: { maxFiles: number; allowMcp: boolean };
    secretsSet: Record<string, boolean>;
  };
  usage: { files: number; inputTokens: number; outputTokens: number; since: string };
  folderpilotAvailable: boolean;
}

/** The server space being viewed (null = a folder on this device, or nothing). */
export function useActiveServerSpace() {
  const mode = useMode((s) => s.mode);
  const org = useActiveOrg();
  const id = useUI((s) => s.activeServerSpaceId);
  const spaces = useServerSpaces(mode === "account" ? org?.id : undefined).data;
  if (mode !== "account" || !org || !id) return null;
  const space = spaces?.find((s) => s.id === id);
  return space ? { ...space, orgId: org.id, role: org.role } : null;
}

const base = (orgId: string, spaceId: string) => `/api/orgs/${orgId}/spaces/${spaceId}`;

export function useSpaceStatus(orgId: string, spaceId: string) {
  return useQuery({
    queryKey: ["space", spaceId, "status"],
    queryFn: () => api<SpaceStatus>(`${base(orgId, spaceId)}/status`),
    // Poll while work is in flight.
    refetchInterval: (q) => (q.state.data && (q.state.data.scanning || q.state.data.pendingAnalysis > 0) ? 1500 : 10_000),
  });
}

export function useSpaceFiles(orgId: string, spaceId: string, filter: { status?: FileStatus; flag?: FileFlag; q?: string } = {}) {
  const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
  return useQuery({
    queryKey: ["space", spaceId, "files", filter],
    queryFn: () => api<{ files: SpaceFile[]; total: number }>(`${base(orgId, spaceId)}/files?${params}`),
  });
}

export function useSpaceDuplicates(orgId: string, spaceId: string) {
  return useQuery({ queryKey: ["space", spaceId, "duplicates"], queryFn: () => api<{ groups: DuplicateGroup[] }>(`${base(orgId, spaceId)}/duplicates`) });
}

export function useSpaceAudit(orgId: string, spaceId: string) {
  return useQuery({ queryKey: ["space", spaceId, "audit"], queryFn: () => api<{ events: SpaceAuditEvent[] }>(`${base(orgId, spaceId)}/audit`) });
}

/** Anything that changes files refreshes every view of the space. */
function useInvalidate(spaceId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["space", spaceId] });
}

export function useScan(orgId: string, spaceId: string) {
  const invalidate = useInvalidate(spaceId);
  return useMutation({
    mutationFn: (withAI: boolean) => api<{ queued: boolean }>(`${base(orgId, spaceId)}/scan`, { method: "POST", body: JSON.stringify({ withAI }) }),
    onSettled: invalidate,
  });
}

export function useReview(orgId: string, spaceId: string) {
  const invalidate = useInvalidate(spaceId);
  return useMutation({
    mutationFn: (body: ReviewAction) => api<ReviewResult>(`${base(orgId, spaceId)}/review`, { method: "POST", body: JSON.stringify(body) }),
    onSettled: invalidate,
  });
}

export function useUndoBatch(orgId: string, spaceId: string) {
  const invalidate = useInvalidate(spaceId);
  return useMutation({
    mutationFn: (batchId: string) => api<{ done: number; failed: number; errors: string[] }>(`${base(orgId, spaceId)}/undo`, { method: "POST", body: JSON.stringify({ batchId }) }),
    onSettled: invalidate,
  });
}

export function useOrgAIStatus(orgId: string | undefined) {
  return useQuery({ queryKey: ["org-ai-status", orgId], enabled: Boolean(orgId), queryFn: () => api<{ provider: string; label: string | null; folderpilotAvailable: boolean }>(`/api/orgs/${orgId}/ai/status`) });
}

export function useOrgAISettings(orgId: string | undefined, enabled: boolean) {
  return useQuery({ queryKey: ["org-ai-settings", orgId], enabled: Boolean(orgId) && enabled, queryFn: () => api<OrgAISettings>(`/api/orgs/${orgId}/settings/ai`) });
}
