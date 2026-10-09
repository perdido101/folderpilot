import { Bot, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Placeholder for the agent chat (Phase 6). */
export function AgentPanel() {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-surface" aria-label="Agent">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Bot className="size-4 text-accent" />
        <span className="font-medium">Agent</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="rounded-full bg-accent-soft p-3 text-accent">
          <Bot className="size-5" />
        </div>
        <p className="font-medium">Ask in plain language</p>
        <p className="text-xs text-muted">
          "Organize this by client", "find the signed NDA with Alpha". Every change is shown as a plan you approve first.
        </p>
        <p className="mt-2 text-xs text-muted">Coming in a later phase.</p>
      </div>
      <form className="flex gap-2 border-t p-3" onSubmit={(e) => e.preventDefault()}>
        <Input placeholder="Ask FolderPilot…" disabled />
        <Button size="icon" disabled aria-label="Send">
          <Send />
        </Button>
      </form>
    </aside>
  );
}
