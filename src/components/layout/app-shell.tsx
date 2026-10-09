import { Outlet } from "react-router-dom";
import { useUI } from "@/stores/ui";
import { AgentPanel } from "./agent-panel";
import { BrowserNotice } from "./browser-notice";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

export function AppShell() {
  const agentPanelOpen = useUI((s) => s.agentPanelOpen);
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
    </div>
  );
}
