import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@folderpilot/ui";
import { authClient } from "@/lib/auth-client";
import { AuthLayout, Field, FormError } from "./auth-layout";
import { DeviceModeLink } from "./device-mode-link";
import { SocialButtons } from "./social-buttons";

export const MIN_PASSWORD = 10;

export function SignUpPage() {
  const { t } = useTranslation("auth");
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/onboarding";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthLayout
      title={t("signUp.title")}
      subtitle={t("signUp.subtitle")}
      footer={
        <div className="space-y-2">
          <p>
            {t("signUp.haveAccount")}{" "}
            <Link className="text-accent hover:underline" to={`/sign-in${next !== "/onboarding" ? `?next=${encodeURIComponent(next)}` : ""}`}>
              {t("signUp.signIn")}
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
          if (password.length < MIN_PASSWORD) return setError(t("errors.passwordTooShort", { min: MIN_PASSWORD }));
          setBusy(true);
          setError(null);
          const { error: err } = await authClient.signUp.email({ name, email, password });
          setBusy(false);
          if (err) return setError(err.code === "USER_ALREADY_EXISTS" || err.status === 422 ? t("errors.emailTaken") : (err.message ?? t("errors.generic")));
          await qc.invalidateQueries({ queryKey: ["me"] });
          navigate(next);
        }}
      >
        <Field label={t("fields.name")}>
          <Input autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("fields.email")}>
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("fields.password")} hint={t("fields.passwordHint", { min: MIN_PASSWORD })}>
          <Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t("signUp.submitting") : t("signUp.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
