import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@folderpilot/ui";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/hooks/use-me";
import { AuthLayout, FormError } from "./auth-layout";

export function AcceptInvitePage() {
  const { t } = useTranslation("auth");
  const { id = "" } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = encodeURIComponent(`/invite/${id}`);

  if (me.isLoading) return null;
  if (!me.data)
    return (
      <AuthLayout title={t("invite.title")} subtitle={t("invite.signInFirst")}>
        <div className="flex flex-col gap-2">
          <Button asChild>
            <Link to={`/sign-up?next=${next}`}>{t("signIn.createAccount")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to={`/sign-in?next=${next}`}>{t("signIn.submit")}</Link>
          </Button>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout title={t("invite.title")} subtitle={t("invite.subtitle", { email: me.data.user.email })}>
      <FormError message={error} />
      <div className="flex flex-col gap-2">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const { data, error: err } = await authClient.organization.acceptInvitation({ invitationId: id });
            setBusy(false);
            if (err || !data) return setError(err?.message ?? t("invite.invalid"));
            await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
            await qc.invalidateQueries({ queryKey: ["me"] });
            navigate("/");
          }}
        >
          {t("invite.accept")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={async () => {
          await authClient.organization.rejectInvitation({ invitationId: id });
          navigate("/");
        }}>
          {t("invite.decline")}
        </Button>
      </div>
    </AuthLayout>
  );
}
