import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useUI } from "@/stores/ui";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      ["Ctrl/⌘ K", "Command palette (navigate, act, ask the agent)"],
      ["/", "Focus search"],
      ["?", "This list"],
    ],
  },
  {
    title: "Files",
    keys: [
      ["Click · Ctrl/⌘-click · Shift-click", "Select · add/remove · range"],
      ["Ctrl/⌘ A", "Select all"],
      ["Arrow keys (+ Shift)", "Move focus (extend selection)"],
      ["Space / Enter / double-click", "Quick-look"],
      ["Esc", "Clear selection"],
    ],
  },
  {
    title: "Quick-look",
    keys: [
      ["← →", "Previous / next file"],
      ["Space / Esc", "Close"],
    ],
  },
  {
    title: "Review mode",
    keys: [
      ["→", "Keep"],
      ["←", "Trash (moved to FolderPilot Trash)"],
      ["Backspace / Z", "Back"],
    ],
  },
];

export function ShortcutsOverlay() {
  const { shortcutsOpen, setShortcutsOpen } = useUI();
  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>FolderPilot works without a mouse.</DialogDescription>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{g.title}</h3>
              <dl className="space-y-1.5 text-sm">
                {g.keys.map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 rounded border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{k}</dt>
                    <dd className="text-right text-muted">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
