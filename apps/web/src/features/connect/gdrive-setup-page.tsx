/** After Google sign-in: choose the Drive folder this space organizes, name it, start the first scan. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, CircleAlert, Folder, HardDrive, Loader2 } from "lucide-react";
import { Button, Input } from "@folderpilot/ui";
import { useActiveOrg, useServerSpaces } from "@/hooks/use-me";
import { useMode } from "@/stores/mode";
import { useUI } from "@/stores/ui";
import { toast } from "@/stores/toasts";
import { startGoogleDrive, useProviderFolders, useUpdateSpace } from "./api";

export function GoogleDriveSetupPage() {
  const { t } = useTranslation("connect");
  const { spaceId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const org = useActiveOrg();
  const space = useServerSpaces(org?.id).data?.find((s) => s.id === spaceId);
  const setActive = useUI((s) => s.setActiveServerSpaceId);
  const setMode = useMode((s) => s.setMode);
  // Breadcrumb of opened folders; the last one is shown.
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([{ id: "root", name: "My Drive" }]);
  const current = trail[trail.length - 1]!;
  const folders = useProviderFolders(org?.id, spaceId, current.id);
  const update = useUpdateSpace(org?.id, spaceId);
  const [name, setName] = useState("");

  useEffect(() => {
    if (space && !name) setName(space.name);
  }, [space, name]);

  // A reconnect keeps the chosen folder: go straight back to the space.
  useEffect(() => {
    if (params.get("reconnected") && space && !space.needsFolder) {
      setMode("account");
      setActive(space.id);
      toast(t("gdrive.reconnected"));
      navigate("/", { replace: true });
    }
  }, [params, space, setActive, setMode, navigate, t]);

  async function choose(rootRef: string) {
    try {
      await update.mutateAsync({ rootRef, ...(name.trim() ? { name: name.trim() } : {}) });
      setMode("account");
      setActive(spaceId);
      toast(t("gdrive.started"));
      navigate("/");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <HardDrive className="size-5 text-accent" />
          {t("gdrive.setupTitle")}
        </h1>
        <p className="mt-1 text-sm text-muted">{t("gdrive.setupDescription")}</p>
        {space?.settings.account && <p className="mt-1 text-xs text-muted">{t("space.account", { account: space.settings.account })}</p>}
      </div>

      <section className="rounded-lg border bg-surface">
        <nav className="flex flex-wrap items-center gap-1 border-b px-3 py-2 text-sm" aria-label="Drive folders">
          {trail.map((f, i) => (
            <span key={`${f.id}-${i}`} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 text-muted" />}
              <button className={i === trail.length - 1 ? "font-medium" : "text-muted hover:text-text"} onClick={() => setTrail(trail.slice(0, i + 1))}>
                {f.name}
              </button>
            </span>
          ))}
        </nav>
        <ul className="max-h-80 overflow-auto p-1" data-testid="drive-folders">
          {folders.isLoading && (
            <li className="flex items-center gap-2 p-3 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> {t("gdrive.loading")}
            </li>
          )}
          {folders.error && <li className="p-3 text-sm text-danger">{folders.error.message}</li>}
          {folders.data?.folders.length === 0 && <li className="p-3 text-sm text-muted">{t("gdrive.noFolders")}</li>}
          {folders.data?.folders.map((f) => (
            <li key={f.id}>
              <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => setTrail([...trail, f])} aria-label={t("gdrive.open", { name: f.name })}>
                <Folder className="size-4 text-muted" />
                <span className="flex-1 truncate">{f.name}</span>
                <ChevronRight className="size-4 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">{t("gdrive.name")}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>

      <div className="flex flex-wrap gap-2">
        <Button disabled={update.isPending || current.id === "root"} onClick={() => void choose(current.id)}>
          {update.isPending ? t("gdrive.saving") : t("gdrive.useThis", { name: current.name })}
        </Button>
        <Button variant="outline" disabled={update.isPending} onClick={() => void choose("root")}>
          {t("gdrive.useAll")}
        </Button>
      </div>
      <p className="text-xs text-muted">{t("gdrive.privacy")}</p>
      {org && space?.needsReconnect && (
        <Button variant="outline" onClick={() => startGoogleDrive(org.id, spaceId)}>
          {t("space.reconnect")}
        </Button>
      )}
    </div>
  );
}

/** Google said no (or the link expired): explain and offer to try again. */
export function GoogleDriveErrorPage() {
  const { t } = useTranslation("connect");
  const [params] = useSearchParams();
  const org = useActiveOrg();
  return (
    <div className="mx-auto w-full max-w-lg space-y-4 p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <CircleAlert className="size-5 text-danger" />
        {t("gdrive.errorTitle")}
      </h1>
      <p className="text-sm" role="alert">
        {params.get("message")}
      </p>
      <div className="flex gap-2">
        {org && <Button onClick={() => startGoogleDrive(org.id)}>{t("gdrive.tryAgain")}</Button>}
        <Button variant="outline" asChild>
          <Link to="/">{t("gdrive.home")}</Link>
        </Button>
      </div>
    </div>
  );
}
