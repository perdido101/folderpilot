import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@folderpilot/ui";
import { authClient } from "@/lib/auth-client";
import { AuthLayout, Field, FormError } from "./auth-layout";
import { DeviceModeLink } from "./device-mode-link";
import { SocialButtons } from "./social-buttons";

export function SignInPage() {
  const { t } = useTranslation("auth");
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthLayout
      title={t("signIn.title")}
      subtitle={t("signIn.subtitle")}
      footer={
        <div className="space-y-2">
          <p>
            {t("signIn.noAccount")}{" "}
            <Link className="text-accent hover:underline" to={`/sign-up${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}>
              {t("signIn.createAccount")}
            </Link>
          </p>
          <DeviceModeLink />
        </div>
      }
    >
      <SocialButtons callbackPath={next} />
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const { error: err } = await authClient.signIn.email({ email, password });
          setBusy(false);
          if (err) return setError(err.status === 401 ? t("errors.invalidCredentials") : (err.message ?? t("errors.generic")));
          await qc.invalidateQueries({ queryKey: ["me"] });
          navigate(next);
        }}
      >
        <Field label={t("fields.email")}>
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("fields.password")}>
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t("signIn.submitting") : t("signIn.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
