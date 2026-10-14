import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, LogIn, LogOut, Plus, User } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@folderpilot/ui";
import { authClient } from "@/lib/auth-client";
import { useActiveOrg, useMe } from "@/hooks/use-me";
import { LOCAL_ONLY, useMode } from "@/stores/mode";

/** Organization switcher + account actions. In device mode: a way to sign in instead. */
export function AccountMenu() {
  const { t } = useTranslation("shell");
  const { mode, setMode } = useMode();
  const me = useMe().data;
  const active = useActiveOrg();
  const qc = useQueryClient();
  const navigate = useNavigate();

  if (mode === "device") {
    if (LOCAL_ONLY) return null;
    return (
      <button
        onClick={() => {
          setMode("account");
          navigate("/sign-in");
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs hover:bg-surface-2"
      >
        <LogIn className="size-3.5" />
        {t("account.signIn")}
      </button>
    );
  }
  if (!me) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="inline-flex h-8 max-w-56 items-center gap-2 rounded-lg border px-2.5 text-xs hover:bg-surface-2" aria-label={t("account.switcher")}>
          <Building2 className="size-3.5 shrink-0 text-muted" />
          <span className="truncate font-medium">{active?.name ?? t("account.noOrg")}</span>
          <ChevronsUpDown className="size-3 shrink-0 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="px-2 py-1.5 text-xs text-muted">
          <p className="flex items-center gap-1.5 font-medium text-text">
            <User className="size-3.5" />
            {me.user.name}
          </p>
          <p className="truncate">{me.user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">{t("account.organizations")}</p>
        {me.organizations.map((o) => (
          <DropdownMenuItem
            key={o.id}
            onSelect={async () => {
              await authClient.organization.setActive({ organizationId: o.id });
              await qc.invalidateQueries();
            }}
          >
            {o.id === active?.id ? <Check className="text-accent" /> : <span className="size-4" />}
            <span className="flex-1 truncate">{o.name}</span>
            <span className="text-[11px] text-muted">{t(`roles.${o.role}`)}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => navigate("/onboarding")}>
          <Plus />
          {t("account.newOrg")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await authClient.signOut();
            qc.clear();
            navigate("/sign-in");
          }}
        >
          <LogOut />
          {t("account.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
