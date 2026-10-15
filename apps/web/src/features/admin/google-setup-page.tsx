/**
 * Admin → Google Drive: a guided, one-time setup. Step-by-step links straight into Google Cloud, the exact addresses
 * to paste (with copy buttons), then the two keys pasted here. The server checks them with Google before saving.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { startGoogleDrive } from "@/features/connect/api";
import { useActiveOrg } from "@/hooks/use-me";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Copy, ExternalLink, HardDrive } from "lucide-react";
import { Button, Input } from "@folderpilot/ui";
import { api } from "@/lib/api";
import { toast } from "@/stores/toasts";

interface GoogleSetup {
  isServerAdmin: boolean;
  configured: boolean;
  source: "env" | "app" | null;
  clientId: string | null;
  origin: string;
  redirectUris: string[];
}

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation("admin");
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border bg-surface-2 px-2 py-1.5 font-mono text-xs" title={value}>
          {value}
        </code>
        <Button
          size="sm"
          variant="outline"
          aria-label={t("google.copy", { label })}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast(t("google.copyFailed"), "error");
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("google.copied") : t("google.copyButton")}
        </Button>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pb-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="space-y-2 text-sm text-muted">{children}</div>
      </div>
    </li>
  );
}

function Open({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button size="sm" variant="outline" asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children} <ExternalLink />
      </a>
    </Button>
  );
}

export function GoogleSetupPage() {
  const { t } = useTranslation("admin");
  const org = useActiveOrg();
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ["admin-google"], queryFn: () => api<GoogleSetup>("/api/admin/google") });
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin-google"] }), qc.invalidateQueries({ queryKey: ["features"] })]);
  const save = useMutation({
    mutationFn: () => api<{ verified: boolean }>("/api/admin/google", { method: "PUT", body: JSON.stringify({ clientId, clientSecret: secret }) }),
    onSuccess: async (r) => {
      setSecret("");
      toast(r.verified ? t("google.saved") : t("google.savedUnverified"), "success");
      await done();
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });
  const remove = useMutation({
    mutationFn: () => api("/api/admin/google", { method: "DELETE" }),
    onSuccess: async () => {
      toast(t("google.removed"));
      await done();
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "error"),
  });

  const s = setup.data;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="flex items-center gap-2 font-semibold">
            <HardDrive className="size-4 text-accent" />
            {t("google.title")}
          </h1>
          <p className="text-xs text-muted">{t("google.subtitle")}</p>
          <Link to="/admin" className="text-xs text-accent hover:underline">
            {t("google.back")}
          </Link>
        </div>

        {s?.configured && (
          <section className="flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-surface p-4" data-testid="google-ready">
            <CheckCircle2 className="size-5 text-success" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{t("google.ready")}</p>
              <p className="text-xs text-muted">{s.source === "env" ? t("google.fromEnv") : t("google.fromApp", { clientId: s.clientId ?? "" })}</p>
            </div>
            {org && ["owner", "admin"].includes(org.role) && <Button onClick={() => startGoogleDrive(org.id)}>{t("google.connectNow")}</Button>}
          </section>
        )}

        {s && !s.isServerAdmin && !s.configured && <p className="rounded-lg border bg-surface p-4 text-sm">{t("google.notAdmin")}</p>}

        {s?.isServerAdmin && s.source !== "env" && (
          <section className="space-y-4 rounded-lg border bg-surface p-4">
            <p className="text-sm">{t("google.intro")}</p>
            <ol className="space-y-5">
              <Step n={1} title={t("google.step1.title")}>
                <p>{t("google.step1.body")}</p>
                <Open href="https://console.cloud.google.com/projectcreate">{t("google.step1.button")}</Open>
              </Step>
              <Step n={2} title={t("google.step2.title")}>
                <p>{t("google.step2.body")}</p>
                <Open href="https://console.cloud.google.com/apis/library/drive.googleapis.com">{t("google.step2.button")}</Open>
              </Step>
              <Step n={3} title={t("google.step3.title")}>
                <p>{t("google.step3.body")}</p>
                <Open href="https://console.cloud.google.com/auth/overview">{t("google.step3.button")}</Open>
              </Step>
              <Step n={4} title={t("google.step4.title")}>
                <p>{t("google.step4.body")}</p>
                <Open href="https://console.cloud.google.com/auth/audience">{t("google.step4.button")}</Open>
              </Step>
              <Step n={5} title={t("google.step5.title")}>
                <p>{t("google.step5.body")}</p>
                <Open href="https://console.cloud.google.com/auth/clients/create">{t("google.step5.button")}</Open>
                <CopyField label={t("google.origin")} value={s.origin} />
                {s.redirectUris.map((u, i) => (
                  <CopyField key={u} label={t("google.redirect", { n: i + 1 })} value={u} />
                ))}
                <p>{t("google.step5.after")}</p>
              </Step>
              <Step n={6} title={t("google.step6.title")}>
                <p>{t("google.step6.body")}</p>
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate();
                  }}
                >
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-text">{t("google.clientId")}</span>
                    <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890-abc….apps.googleusercontent.com" autoComplete="off" spellCheck={false} />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-text">{t("google.clientSecret")}</span>
                    <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={s.source === "app" ? t("google.secretSaved") : "GOCSPX-…"} autoComplete="off" />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={save.isPending || !clientId.trim() || !secret.trim()}>
                      {save.isPending ? t("google.checking") : t("google.save")}
                    </Button>
                    {s.source === "app" && (
                      <Button type="button" variant="outline" className="text-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                        {t("google.remove")}
                      </Button>
                    )}
                  </div>
                </form>
              </Step>
            </ol>
            <p className="text-xs text-muted">{t("google.note")}</p>
          </section>
        )}
      </div>
    </div>
  );
}
