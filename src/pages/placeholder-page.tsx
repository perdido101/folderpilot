import type { LucideIcon } from "lucide-react";

interface Props {
  title: string;
  description: string;
  phase?: number;
  icon: LucideIcon;
}

export function PlaceholderPage({ title, description, phase, icon: Icon }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="rounded-full bg-surface-2 p-4 text-muted">
        <Icon className="size-6" />
      </div>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-muted">{description}</p>
      {phase !== undefined && <span className="rounded-full border px-3 py-1 text-xs text-muted">Coming in Phase {phase}</span>}
    </div>
  );
}
