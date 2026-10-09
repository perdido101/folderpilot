/** Placeholder until the AI provider layer lands (Phase 3): will show "Local AI" (green) or "Your cloud: <name>" (blue). */
export function AiStatusPill() {
  return (
    <span
      className="inline-flex h-7 items-center gap-2 rounded-full border bg-surface px-3 text-xs text-muted"
      title="Connect a local or cloud AI in Settings (coming in Phase 3)"
    >
      <span className="size-2 rounded-full bg-muted/50" />
      AI not connected
    </span>
  );
}
