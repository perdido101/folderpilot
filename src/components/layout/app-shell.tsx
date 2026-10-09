import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useUI } from "@/stores/ui";
import { Toaster } from "@/components/toaster";
import { GlobalQuickLook } from "@/features/files/quick-look";
import { CommandPalette } from "@/features/palette/command-palette";
import { ShortcutsOverlay } from "@/features/palette/shortcuts-overlay";
import { AgentPanel } from "./agent-panel";
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

export function AppShell() {
  const agentPanelOpen = useUI((s) => s.agentPanelOpen);
  useGlobalShortcuts();
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
          {agentPanelOpen && <AgentPanel />}
        </div>
      </div>
      <GlobalQuickLook />
      <CommandPalette />
      <ShortcutsOverlay />
      <Toaster />
    </div>
  );
}
