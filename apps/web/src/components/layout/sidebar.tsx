import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AppWindow,
  CheckCheck,
  CircleAlert,
  Clock,
  Copy,
  Files,
  FolderPlus,
  HardDrive,
  Inbox,
  Laptop,
  Link2,
  Plus,
  ScrollText,
  Settings,
  Shapes,
  Shield,
  Trash2,
  Upload,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { roleAtLeast } from "@folderpilot/core";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, cn } from "@folderpilot/ui";
import { openMiniWindow } from "@/features/palette/command-palette";
import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/db";
import { api } from "@/lib/api";
import { useActiveServerSpace, type SpaceStatus } from "@/features/server-space/api";
import { useActiveRoot } from "@/hooks/use-active-root";
import { useActiveOrg, useServerSpaces } from "@/hooks/use-me";
import { useMode } from "@/stores/mode";
import { useUI } from "@/stores/ui";
import { ConnectSourceDialog } from "./connect-source-dialog";

type NavKey = "review" | "recent" | "allFiles" | "categories" | "duplicates" | "rules" | "approvals" | "audit" | "shared" | "trash" | "settings" | "admin";

export const NAV: { to: string; labelKey: `nav.${NavKey}`; icon: LucideIcon; adminOnly?: boolean; accountOnly?: boolean }[] = [
  { to: "/review", labelKey: "nav.review", icon: Inbox },
  { to: "/recent", labelKey: "nav.recent", icon: Clock },
  { to: "/", labelKey: "nav.allFiles", icon: Files },
  { to: "/categories", labelKey: "nav.categories", icon: Shapes },
  { to: "/duplicates", labelKey: "nav.duplicates", icon: Copy },
  { to: "/rules", labelKey: "nav.rules", icon: Workflow },
  { to: "/approvals", labelKey: "nav.approvals", icon: CheckCheck },
  { to: "/audit", labelKey: "nav.audit", icon: ScrollText },
  { to: "/shared", labelKey: "nav.shared", icon: Link2, accountOnly: true },
  { to: "/trash", labelKey: "nav.trash", icon: Trash2 },
  { to: "/settings", labelKey: "nav.settings", icon: Settings },
  { to: "/admin", labelKey: "nav.admin", icon: Shield, adminOnly: true, accountOnly: true },
];

/** NAV entries this user may see: Admin for owners/admins only, Shared/Admin only with an account. */
export function useVisibleNav() {
  const mode = useMode((s) => s.mode);
  const org = useActiveOrg();
  const isAdmin = mode === "account" && org !== null && roleAtLeast(org.role, "admin");
  return NAV.filter((n) => (!n.adminOnly || isAdmin) && (!n.accountOnly || mode === "account"));
}

function NewMenu({ onConnect }: { onConnect: () => void }) {
  const { t } = useTranslation(["shell", "common"]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="w-full justify-start" size="default">
          <Plus />
          {t("new.button")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem disabled title={t("common:status.comingInPhase", { phase: 7 })}>
          <Upload />
          {t("new.upload")}
          <span className="ml-auto text-[10px] text-muted">{t("new.soon")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled title={t("common:status.comingInPhase", { phase: 2 })}>
          <FolderPlus />
          {t("new.folder")}
          <span className="ml-auto text-[10px] text-muted">{t("new.soon")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onConnect}>
          <HardDrive />
          {t("new.connect")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar() {
  const { t } = useTranslation(["shell", "common"]);
  const mode = useMode((s) => s.mode);
  const org = useActiveOrg();
  const navigate = useNavigate();
  const serverSpaces = useServerSpaces(mode === "account" ? org?.id : undefined).data ?? [];
  const activeRoot = useActiveRoot();
  const activeRootId = activeRoot?.id ?? null;
  const setActiveRootId = useUI((s) => s.setActiveRootId);
  const setActiveServerSpaceId = useUI((s) => s.setActiveServerSpaceId);
  const serverSpace = useActiveServerSpace();
  const activeServerSpaceId = serverSpace?.id ?? null;
  const serverStatus = useQuery({
    queryKey: ["space", activeServerSpaceId, "status"],
    enabled: Boolean(serverSpace),
    queryFn: () => api<SpaceStatus>(`/api/orgs/${serverSpace!.orgId}/spaces/${serverSpace!.id}/status`),
  }).data;
  const [connectOpen, setConnectOpen] = useState(false);
  const roots = useLiveQuery(() => db.roots.orderBy("addedAt").toArray(), [], []);
  const needsReview = useLiveQuery(
    async () =>
      activeRootId === null
        ? 0
        : await db.files
            .where("rootId")
            .equals(activeRootId)
            .filter((f) => f.status === "needs_review" || (f.flags.includes("suggested_delete") && f.status !== "trashed"))
            .count(),
    [activeRootId],
    0,
  );
  const pending = useLiveQuery(() => (activeRootId === null ? 0 : db.plans.where("rootId").equals(activeRootId).filter((p) => p.status === "pending").count()), [activeRootId], 0);
  const nav = useVisibleNav();
  const serverPending = useQuery({
    queryKey: ["space", activeServerSpaceId, "plans", "pending"],
    enabled: Boolean(serverSpace),
    queryFn: () => api<{ plans: unknown[] }>(`/api/orgs/${serverSpace!.orgId}/spaces/${serverSpace!.id}/plans?status=pending`),
    refetchInterval: 15_000,
  }).data;
  const badges: Partial<Record<NavKey, number>> = serverSpace ? { review: serverStatus?.needsReview ?? 0, approvals: serverPending?.plans.length ?? 0 } : { review: needsReview, approvals: pending };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-surface">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-6" />
        <span className="font-semibold tracking-tight">{t("common:appName")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-2">
          <NewMenu onConnect={() => setConnectOpen(true)} />
        </div>

        <section className="px-2 pb-2" aria-labelledby="spaces-heading">
          <h2 id="spaces-heading" className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("spaces.heading")}
          </h2>
          {roots.length === 0 && serverSpaces.length === 0 && (
            <button onClick={() => setConnectOpen(true)} className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-muted hover:bg-surface-2 hover:text-text">
              {t("spaces.empty")}
            </button>
          )}
          {roots.map((root) => (
            <button
              key={`local-${root.id}`}
              onClick={() => setActiveRootId(root.id)}
              className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-2", !serverSpace && root.id === activeRootId && "bg-surface-2 font-medium")}
              title={t("spaces.deviceHint")}
            >
              <Laptop className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{root.name}</span>
              <span className="rounded-full border px-1.5 text-[10px] text-muted">{root.readOnly ? t("spaces.readOnly") : t("modes.private")}</span>
            </button>
          ))}
          {serverSpaces.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setActiveServerSpaceId(s.id);
                // A Drive connected a moment ago still needs its folder.
                if (s.needsFolder) navigate(`/connect/gdrive/${s.id}`);
              }}
              className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-2", s.id === activeServerSpaceId && "bg-surface-2 font-medium")}
              title={t("spaces.serverHint")}
            >
              <HardDrive className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {(s.needsReconnect || s.needsFolder) && <CircleAlert className="size-3.5 shrink-0 text-warning" aria-label={s.needsReconnect ? t("spaces.needsReconnect") : t("spaces.needsFolder")} />}
              <span className="rounded-full border px-1.5 text-[10px] text-muted">{t(`modes.${s.mode}`)}</span>
            </button>
          ))}
        </section>

        <nav className="flex flex-col gap-0.5 border-t p-2" aria-label={t("nav.label")}>
          {nav.map(({ to, labelKey, icon: Icon }) => {
            const key = labelKey.slice(4) as NavKey;
            const badge = badges[key] ?? 0;
            return (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) =>
                  cn("flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors", isActive ? "bg-accent-soft font-medium text-accent" : "text-text hover:bg-surface-2")
                }
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{t(labelKey)}</span>
                {badge > 0 && <span className="ml-auto rounded-full bg-warning/10 px-2 text-xs font-medium text-warning">{badge}</span>}
              </NavLink>
            );
          })}
        </nav>
      </div>

      <button onClick={openMiniWindow} className="flex items-center gap-2 border-t px-5 py-3 text-xs text-muted hover:bg-surface-2 hover:text-text" title={t("mini.hint")}>
        <AppWindow className="size-4" />
        {t("mini.label")}
      </button>
      <ConnectSourceDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </aside>
  );
}
