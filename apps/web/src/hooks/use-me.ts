import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type Features, type Me, type ServerSpace } from "@/lib/api";
import { useMode } from "@/stores/mode";

/** The signed-in user (null when signed out). Throws OfflineError when the server is unreachable. */
export function useMe() {
  const mode = useMode((s) => s.mode);
  return useQuery({
    queryKey: ["me"],
    enabled: mode === "account",
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/api/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

export function useActiveOrg() {
  const me = useMe().data;
  return me?.organizations.find((o) => o.id === me.activeOrganizationId) ?? me?.organizations[0] ?? null;
}

export function useFeatures() {
  const mode = useMode((s) => s.mode);
  return useQuery({ queryKey: ["features"], enabled: mode === "account", staleTime: 5 * 60_000, queryFn: () => api<Features>("/api/config/features") });
}

export function useServerSpaces(orgId: string | undefined) {
  return useQuery({ queryKey: ["spaces", orgId], enabled: Boolean(orgId), queryFn: () => api<ServerSpace[]>(`/api/orgs/${orgId}/spaces`) });
}
