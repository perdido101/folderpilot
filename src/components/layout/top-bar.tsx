import { PanelRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUI } from "@/stores/ui";
import { AiStatusPill } from "./ai-status-pill";
import { ThemeToggle } from "./theme-toggle";

export function TopBar() {
  const search = useUI((s) => s.search);
  const setSearch = useUI((s) => s.setSearch);
  const agentPanelOpen = useUI((s) => s.agentPanelOpen);
  const toggleAgentPanel = useUI((s) => s.toggleAgentPanel);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-surface px-4">
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLInputElement).blur()}
          placeholder="Search files by name or folder…"
          className="pl-9"
          aria-label="Search files"
        />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <AiStatusPill />
        <ThemeToggle />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleAgentPanel}
          aria-label={agentPanelOpen ? "Hide agent panel" : "Show agent panel"}
          aria-pressed={agentPanelOpen}
        >
          <PanelRight />
        </Button>
      </div>
    </header>
  );
}
