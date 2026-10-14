import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, UserPlus } from "lucide-react";
import { can, ROLES, type Role } from "@folderpilot/core";
import { Button, Input } from "@folderpilot/ui";
import { api, type Member } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useActiveOrg, useMe } from "@/hooks/use-me";
import { toast } from "@/stores/toasts";
import { PlaceholderPage } from "@/pages/placeholder-page";

const selectCls = "h-9 rounded-lg border bg-surface px-2 text-sm disabled:opacity-60";

/** Admin: members and roles, invitations. */
export function MembersPage() {
  const { t } = useTranslation(["admin", "shell"]);
  const org = useActiveOrg();
  const me = useMe().data;
  const qc = useQueryClient();
  const allowed = org !== null && can(org.role, "member", "update");
  const members = useQuery({ queryKey: ["members", org?.id], enabled: allowed, queryFn: () => api<Member[]>(`/api/orgs/${org!.id}/members`) });
  const invitations = useQuery({
    queryKey: ["invitations", org?.id],
    enabled: allowed,
    queryFn: async () => (await authClient.organization.listInvitations({ query: { organizationId: org!.id } })).data ?? [],
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);

  if (!org || !allowed) return <PlaceholderPage icon={Shield} title={t("title")} description={t("notAllowed")} />;
  // Only owners can grant or change the owner role.
  const grantable = ROLES.filter((r) => r !== "owner" || org.role === "owner");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["members", org.id] }), qc.invalidateQueries({ queryKey: ["invitations", org.id] })]);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="font-semibold">{t("title")}</h1>
          <p className="text-xs text-muted">{t("subtitle", { org: org.name })}</p>
        </div>

        <section className="space-y-3 rounded-lg border bg-surface p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <UserPlus className="size-4 text-accent" />
            {t("invite.title")}
          </h2>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const { error } = await authClient.organization.inviteMember({ email: email.trim(), role, organizationId: org.id });
              setBusy(false);
              if (error) return toast(error.message ?? t("invite.failed"), "error");
              toast(t("invite.sent", { email: email.trim() }), "success");
              setEmail("");
              await refresh();
            }}
          >
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("invite.emailPlaceholder")} className="min-w-56 flex-1" aria-label={t("invite.email")} />
            <select className={selectCls} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label={t("role")}>
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {t(`shell:roles.${r}`)}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={busy}>
              {t("invite.submit")}
            </Button>
          </form>
          <p className="text-xs text-muted">{t("invite.hint")}</p>
          {invitations.data?.filter((i) => i.status === "pending").length ? (
            <ul className="divide-y rounded-lg border text-sm">
              {invitations.data
                .filter((i) => i.status === "pending")
                .map((i) => (
                  <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate">{i.email}</span>
                    <span className="text-xs text-muted">{t(`shell:roles.${(i.role ?? "viewer") as Role}`)}</span>
                    <span className="text-xs text-muted">{t("invite.pending")}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await authClient.organization.cancelInvitation({ invitationId: i.id });
                        await refresh();
                      }}
                    >
                      {t("invite.cancel")}
                    </Button>
                  </li>
                ))}
            </ul>
          ) : null}
        </section>

        <section className="rounded-lg border bg-surface">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">{t("members.title", { count: members.data?.length ?? 0 })}</h2>
          <ul className="divide-y">
            {members.data?.map((m) => {
              const self = m.userId === me?.user.id;
              const locked = self || (m.role === "owner" && org.role !== "owner");
              return (
                <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {m.name} {self && <span className="text-xs font-normal text-muted">({t("members.you")})</span>}
                    </p>
                    <p className="truncate text-xs text-muted">{m.email}</p>
                  </div>
                  <select
                    className={selectCls}
                    value={m.role}
                    disabled={locked}
                    aria-label={t("role")}
                    onChange={async (e) => {
                      const { error } = await authClient.organization.updateMemberRole({ memberId: m.id, role: e.target.value as Role, organizationId: org.id });
                      if (error) toast(error.message ?? t("members.updateFailed"), "error");
                      else toast(t("members.updated", { name: m.name }), "success");
                      await refresh();
                    }}
                  >
                    {(locked ? ROLES : grantable).map((r) => (
                      <option key={r} value={r}>
                        {t(`shell:roles.${r}`)}
                      </option>
                    ))}
                  </select>
                  {!locked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={async () => {
                        if (!confirm(t("members.confirmRemove", { name: m.name }))) return;
                        const { error } = await authClient.organization.removeMember({ memberIdOrEmail: m.id, organizationId: org.id });
                        if (error) toast(error.message ?? t("members.updateFailed"), "error");
                        await refresh();
                      }}
                    >
                      {t("members.remove")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <p className="text-xs text-muted">{t("rolesHelp")}</p>
      </div>
    </div>
  );
}
