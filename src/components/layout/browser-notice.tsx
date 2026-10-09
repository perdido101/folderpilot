import { TriangleAlert } from "lucide-react";
import { isFileSystemAccessSupported } from "@/lib/fs-access";

export function BrowserNotice() {
  if (isFileSystemAccessSupported()) return null;
  return (
    <div className="flex items-center gap-2 border-b bg-warning/10 px-4 py-2 text-sm text-warning">
      <TriangleAlert className="size-4 shrink-0" />
      FolderPilot needs Chrome or Edge on desktop to open folders on your computer. Your files never leave your machine.
    </div>
  );
}
