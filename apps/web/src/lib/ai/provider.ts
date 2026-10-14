import { createProvider, type AIProvider, type AISettings } from "@folderpilot/ai";
import { useMode } from "@/stores/mode";
import { useOrgStore } from "@/stores/org";

/** The AI for folders on this device. FolderPilot AI needs a signed-in organization (it runs through our API). */
export function browserProvider(ai: AISettings): AIProvider | null {
  const orgId = useMode.getState().mode === "account" ? useOrgStore.getState().activeOrgId : null;
  return createProvider(ai, { orgId });
}

/** React version: re-renders when the active organization changes. */
export function useBrowserProvider(ai: AISettings): AIProvider | null {
  const mode = useMode((s) => s.mode);
  const orgId = useOrgStore((s) => s.activeOrgId);
  return createProvider(ai, { orgId: mode === "account" ? orgId : null });
}
