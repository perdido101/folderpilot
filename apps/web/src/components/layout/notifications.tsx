import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@folderpilot/ui";

/**
 * Notifications (plan waiting for approval, sync finished, …). The table exists already;
 * events start flowing once plans run on the server (Phase 2+), so the list is empty for now.
 */
export function Notifications() {
  const { t } = useTranslation("shell");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("notifications.label")} title={t("notifications.label")}>
          <Bell />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="text-sm font-medium">{t("notifications.label")}</p>
        <p className="mt-6 pb-4 text-center text-sm text-muted">{t("notifications.empty")}</p>
      </PopoverContent>
    </Popover>
  );
}
