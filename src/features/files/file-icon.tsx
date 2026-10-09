import { Archive, File, FileCode, FileText, Film, Image, Music, Sheet, type LucideIcon } from "lucide-react";
import type { FileKind } from "@/lib/file-kinds";
import { cn } from "@/lib/utils";

const ICONS: Record<FileKind, LucideIcon> = {
  image: Image,
  document: FileText,
  spreadsheet: Sheet,
  video: Film,
  audio: Music,
  archive: Archive,
  code: FileCode,
  other: File,
};

export function FileIcon({ kind, className }: { kind: FileKind; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon className={cn("shrink-0 text-muted", className)} />;
}
