import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Full-page navigation to Google's consent screen (the server redirects there). */
export function startGoogleDrive(orgId: string, reconnectSpaceId?: string) {
  window.location.assign(`${base}/api/orgs/${orgId}/connect/gdrive/start${reconnectSpaceId ? `?spaceId=${encodeURIComponent(reconnectSpaceId)}` : ""}`);
}

export interface ProviderFolders {
  parent: string;
  name: string;
  folders: { id: string; name: string }[];
}

export function useProviderFolders(orgId: string | undefined, spaceId: string, parent: string) {
  return useQuery({
    queryKey: ["provider-folders", spaceId, parent],
    enabled: Boolean(orgId),
    queryFn: () => api<ProviderFolders>(`/api/orgs/${orgId}/spaces/${spaceId}/provider-folders?parent=${encodeURIComponent(parent)}`),
  });
}

export function useUpdateSpace(orgId: string | undefined, spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; rootRef?: string }) => api<{ id: string; name: string; scanning: boolean }>(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["spaces", orgId] });
      void qc.invalidateQueries({ queryKey: ["space", spaceId] });
    },
  });
}

export function useDisconnectSpace(orgId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string) => api<{ ok: boolean; revoked: boolean }>(`/api/orgs/${orgId}/spaces/${spaceId}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["spaces", orgId] }),
  });
}
