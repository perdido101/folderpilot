import { Bot, FolderInput, PenLine, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const ACTIONS = [
  { label: "Move", icon: FolderInput },
  { label: "Tag", icon: Tag },
  { label: "Rename", icon: PenLine },
  { label: "Ask agent", icon: Bot },
  { label: "Trash", icon: Trash2 },
] as const;

/** Floating action bar. Actions are wired up with the action engine (Phase 4). */
export function SelectionBar({ count, onClear }: { count: number; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-lg border bg-surface p-1.5 shadow-sm animate-in fade-in-0 slide-in-from-bottom-2">
        <span className="px-3 text-sm font-medium tabular-nums">{count.toLocaleString()} selected</span>
        <span className="mx-1 h-5 w-px bg-border" />
        {ACTIONS.map(({ label, icon: Icon }) => (
          <Button key={label} variant="ghost" size="sm" disabled title={`${label} — coming soon`}>
            <Icon />
            {label}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)">
          <X />
        </Button>
      </div>
    </div>
  );
}
