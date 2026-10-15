import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useUI } from "@/stores/ui";
import { useMode } from "@/stores/mode";
import { runDueScheduledRules } from "@/lib/rules/device-runner";
import { announceRuleOutcomes } from "@/features/rules/announce";
import { navigateTo } from "@/lib/navigation";
import { RuleDraftHost } from "@/features/rules/draft";
import { Toaster } from "@/components/toaster";
import { GlobalQuickLook } from "@/features/files/quick-look";
import { CommandPalette } from "@/features/palette/command-palette";
import { ShortcutsOverlay } from "@/features/palette/shortcuts-overlay";
import { RightPanel } from "./right-panel";
import { BrowserNotice } from "./browser-notice";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

/** Global shortcuts: Ctrl/⌘+K palette, "?" shortcuts overlay. */
function useGlobalShortcuts() {
  const { setPaletteOpen, setShortcutsOpen } = useUI();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!useUI.getState().paletteOpen);
      } else if (e.key === "?" && !isTyping(e.target)) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, setShortcutsOpen]);
}

/** Scheduled rules for folders on this device run while the app is open (checked every minute). */
function useDeviceRuleSchedule() {
  const mode = useMode((s) => s.mode);
  useEffect(() => {
    if (mode !== "device") return;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const outcomes = await runDueScheduledRules();
        announceRuleOutcomes(
          outcomes.map((o) => ({ mode: o.mode, files: o.files, done: o.result?.done, failed: o.result ? o.result.failed + o.result.conflicted : 0, error: o.error })),
          { quietWhenNothing: true, openApprovals: () => navigateTo("/approvals") },
        );
      } finally {
        running = false;
      }
    };
    const id = window.setInterval(() => void tick(), 60_000);
    void tick();
    return () => window.clearInterval(id);
  }, [mode]);
}

export function AppShell() {
  const agentPanelOpen = useUI((s) => s.agentPanelOpen);
  useGlobalShortcuts();
  useDeviceRuleSchedule();
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <BrowserNotice />
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-hidden">
            <Outlet />
          </main>
          {agentPanelOpen && <RightPanel />}
        </div>
      </div>
      <GlobalQuickLook />
      <CommandPalette />
      <ShortcutsOverlay />
      <Toaster />
      <RuleDraftHost />
    </div>
  );
}
