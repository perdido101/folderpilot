/** Rename a connected space, change its Drive folder, or disconnect it (never touches files in the Drive). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "@folderpilot/ui";
import { useUI } from "@/stores/ui";
import { toast } from "@/stores/toasts";
import type { ActiveServerSpace } from "@/features/server-space/space-header";
import { useDisconnectSpace, useUpdateSpace } from "./api";

export function SpaceSettingsDialog({ space, open, onOpenChange }: { space: ActiveServerSpace; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("connect");
  const navigate = useNavigate();
  const update = useUpdateSpace(space.orgId, space.id);
  const disconnect = useDisconnectSpace(space.orgId);
  const setActive = useUI((s) => s.setActiveServerSpaceId);
  const [name, setName] = useState(space.name);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) {
      setName(space.name);
      setConfirming(false);
    }
  }, [open, space.name]);

  async function save() {
    try {
      await update.mutateAsync({ name: name.trim() });
      toast(t("space.saved"));
      onOpenChange(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function doDisconnect() {
    try {
      await disconnect.mutateAsync(space.id);
      setActive(null);
      onOpenChange(false);
      toast(t("space.disconnected"));
      navigate("/");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {confirming ? (
          <>
            <DialogTitle>{t("space.disconnectTitle", { name: space.name })}</DialogTitle>
            <DialogDescription>{t("space.disconnectBody")}</DialogDescription>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)}>
                {t("space.cancel")}
              </Button>
              <Button variant="destructive" disabled={disconnect.isPending} onClick={() => void doDisconnect()}>
                {t("space.disconnectConfirm")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>{t("space.settings")}</DialogTitle>
            <DialogDescription>{t("space.settingsDescription")}</DialogDescription>
            <div className="space-y-1 text-xs text-muted">
              {space.settings?.account && <p>{t("space.account", { account: space.settings.account })}</p>}
              {space.settings?.rootName && <p>{t("space.folder", { name: space.settings.rootName })}</p>}
            </div>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">{t("space.rename")}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <div className="flex justify-end">
              <Button disabled={update.isPending || !name.trim() || name.trim() === space.name} onClick={() => void save()}>
                {t("space.save")}
              </Button>
            </div>
            {space.adapterId === "gdrive" && (
              <div className="space-y-1 border-t pt-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/connect/gdrive/${space.id}`);
                  }}
                >
                  {t("space.changeFolder")}
                </Button>
                <p className="text-xs text-muted">{t("space.changeFolderNote")}</p>
              </div>
            )}
            <div className="border-t pt-3">
              <Button variant="outline" className="text-danger" onClick={() => setConfirming(true)}>
                {t("space.disconnect")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
