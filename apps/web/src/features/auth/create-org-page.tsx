import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@folderpilot/ui";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/hooks/use-me";
import { AuthLayout, Field, FormError } from "./auth-layout";

/** "Alpha Accounting & Co." → "alpha-accounting-co" (Greek letters are transliterated loosely). */
export function slugify(name: string): string {
  const greek: Record<string, string> = { α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o" };
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[α-ω]/g, (c) => greek[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function CreateOrgPage() {
  const { t } = useTranslation(["auth", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe().data;
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = !me?.organizations.length;

  return (
    <AuthLayout title={first ? t("org.titleFirst") : t("org.title")} subtitle={t("org.subtitle")}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const base = slugify(name) || "org";
          setBusy(true);
          setError(null);
          // Slugs are unique; add a short suffix if the plain one is taken.
          let { data, error: err } = await authClient.organization.create({ name: name.trim(), slug: base });
          if (err && /slug/i.test(err.message ?? "")) ({ data, error: err } = await authClient.organization.create({ name: name.trim(), slug: `${base}-${Math.random().toString(36).slice(2, 6)}` }));
          if (err || !data) {
            setBusy(false);
            return setError(err?.message ?? t("errors.generic"));
          }
          await authClient.organization.setActive({ organizationId: data.id });
          await qc.invalidateQueries({ queryKey: ["me"] });
          navigate("/");
        }}
      >
        <Field label={t("org.name")} hint={t("org.nameHint")}>
          <Input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("org.namePlaceholder")} />
        </Field>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy || name.trim().length < 2}>
          {t("org.submit")}
        </Button>
        {!first && (
          <Button type="button" variant="ghost" className="w-full" onClick={() => navigate(-1)}>
            {t("common:actions.cancel")}
          </Button>
        )}
      </form>
    </AuthLayout>
  );
}
