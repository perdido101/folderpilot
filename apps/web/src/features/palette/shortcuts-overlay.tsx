import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@folderpilot/ui";
import { useUI } from "@/stores/ui";

type GroupKey = "anywhere" | "files" | "quickLook" | "review";
type DescKey =
  | "palette"
  | "focusSearch"
  | "thisList"
  | "select"
  | "selectAll"
  | "moveFocus"
  | "quickLook"
  | "clearSelection"
  | "prevNext"
  | "close"
  | "keep"
  | "trash"
  | "back";
type KeyLabelKey = "clicks" | "arrows" | "spaceEnterDouble";

/** Each shortcut: the keys (literal, or a translated label when it contains words) and what it does. */
const GROUPS: { title: GroupKey; keys: [{ text: string } | { key: KeyLabelKey }, DescKey][] }[] = [
  {
    title: "anywhere",
    keys: [
      [{ text: "Ctrl/⌘ K" }, "palette"],
      [{ text: "/" }, "focusSearch"],
      [{ text: "?" }, "thisList"],
    ],
  },
  {
    title: "files",
    keys: [
      [{ key: "clicks" }, "select"],
      [{ text: "Ctrl/⌘ A" }, "selectAll"],
      [{ key: "arrows" }, "moveFocus"],
      [{ key: "spaceEnterDouble" }, "quickLook"],
      [{ text: "Esc" }, "clearSelection"],
    ],
  },
  {
    title: "quickLook",
    keys: [
      [{ text: "← →" }, "prevNext"],
      [{ text: "Space / Esc" }, "close"],
    ],
  },
  {
    title: "review",
    keys: [
      [{ text: "→" }, "keep"],
      [{ text: "←" }, "trash"],
      [{ text: "Backspace / Z" }, "back"],
    ],
  },
];

export function ShortcutsOverlay() {
  const { shortcutsOpen, setShortcutsOpen } = useUI();
  const { t } = useTranslation("palette");
  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("shortcuts.title")}</DialogTitle>
        <DialogDescription>{t("shortcuts.description")}</DialogDescription>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t(`shortcuts.groups.${g.title}`)}</h3>
              <dl className="space-y-1.5 text-sm">
                {g.keys.map(([k, v]) => (
                  <div key={v} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 rounded border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
                      {"key" in k ? t(`shortcuts.keys.${k.key}`) : k.text}
                    </dt>
                    <dd className="text-right text-muted">{t(`shortcuts.desc.${v}`)}</dd>
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
