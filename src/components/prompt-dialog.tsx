import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirm: string;
  suggestions?: string[];
  /** Live preview under the input. */
  preview?: (value: string) => ReactNode;
  extra?: ReactNode;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({ open, title, description, label, initial = "", placeholder, confirm, suggestions, preview, extra, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initial);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" onKeyDown={(e) => e.stopPropagation()}>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            onSubmit(value.trim());
            onClose();
          }}
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">{label}</span>
            <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} list={suggestions ? "fp-prompt-suggestions" : undefined} />
          </label>
          {suggestions && (
            <datalist id="fp-prompt-suggestions">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          {extra}
          {preview && <div className="max-h-48 overflow-y-auto rounded-lg border bg-surface-2/50 p-2">{preview(value)}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              {confirm}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
