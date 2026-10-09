import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Command, Keyboard, PanelRight, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createProvider } from "@/lib/ai";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useUI } from "@/stores/ui";
import { AiStatusPill } from "./ai-status-pill";
import { ThemeToggle } from "./theme-toggle";

export function TopBar() {
  const { search, setSearch, agentPanelOpen, toggleAgentPanel, semanticSearch, setSemanticSearch, setPaletteOpen, setShortcutsOpen } = useUI();
  const settings = useSettings();
  const canEmbed = Boolean(createProvider(settings.ai)?.embed);
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, like many apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)))) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-surface px-4">
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          ref={inputRef}
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (location.pathname !== "/") navigate("/");
          }}
          onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLInputElement).blur()}
          placeholder="Search names, captions, text… e.g. signed NDA Alpha 2025"
          className="pl-9 pr-10"
          aria-label="Search files"
        />
        {canEmbed && (
          <button
            onClick={() => setSemanticSearch(!semanticSearch)}
            className={cn("absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1", semanticSearch ? "text-accent" : "text-muted hover:text-text")}
            aria-pressed={semanticSearch}
            title={semanticSearch ? "Semantic search on" : "Semantic search off"}
          >
            <Sparkles className="size-4" />
          </button>
        )}
      </div>
      <button onClick={() => setPaletteOpen(true)} className="hidden items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text md:inline-flex" title="Command palette">
        <Command className="size-3" />K
      </button>
      <div className="ml-auto flex items-center gap-2">
        <AiStatusPill />
        <Button variant="ghost" size="icon-sm" onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          <Keyboard />
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="icon-sm" onClick={toggleAgentPanel} aria-label={agentPanelOpen ? "Hide agent panel" : "Show agent panel"} aria-pressed={agentPanelOpen}>
          <PanelRight />
        </Button>
      </div>
    </header>
  );
}
