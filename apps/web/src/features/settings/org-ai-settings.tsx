/** Organization AI (admins): provider, keys (write-only), monthly budget and usage — used by server spaces. */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { Button, Input, cn } from "@folderpilot/ui";
import { roleAtLeast } from "@folderpilot/core";
import { withDefaults, type AISettings, type ProviderKind } from "@folderpilot/ai";
import { api } from "@/lib/api";
import { useActiveOrg } from "@/hooks/use-me";
import { toast } from "@/stores/toasts";
import { useOrgAISettings, type OrgAISettings } from "@/features/server-space/api";

const KINDS: ProviderKind[] = ["none", "folderpilot", "ollama", "openai", "anthropic"];

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function OrgAISettings() {
  const { t } = useTranslation("settings");
  const org = useActiveOrg();
  const admin = Boolean(org && roleAtLeast(org.role, "admin"));
  const query = useOrgAISettings(org?.id, admin);
  const qc = useQueryClient();
  const [form, setForm] = useState<OrgAISettings["settings"] | null>(null);
  const [clear, setClear] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | "testing" | null>(null);

  useEffect(() => {
    if (query.data && !form) setForm({ ...query.data.settings, ai: withDefaults(query.data.settings.ai) });
  }, [query.data, form]);

  if (!org) return null;
  if (!admin)
    return (
      <section className="rounded-lg border bg-surface p-5">
        <h2 className="font-semibold">{t("org.title")}</h2>
        <p className="text-sm text-muted">{t("org.adminOnly")}</p>
      </section>
    );
  if (!form || !query.data) return null;

  const ai = form.ai;
  const set = (next: Partial<AISettings>) => setForm({ ...form, ai: { ...ai, ...next } });
  const secret = (field: string, value: string, onChange: (v: string) => void) => (
    <span className="flex gap-2">
      <Input
        type="password"
        autoComplete="off"
        value={value}
        placeholder={query.data!.settings.secretsSet[field] && !clear.includes(field) ? t("org.secretSaved") : ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {query.data!.settings.secretsSet[field] && !clear.includes(field) && (
        <Button type="button" size="sm" variant="ghost" onClick={() => setClear([...clear, field])}>
          {t("org.clear")}
        </Button>
      )}
    </span>
  );
  const { usage, folderpilotAvailable } = query.data;

  return (
    <form
      className="space-y-4 rounded-lg border bg-surface p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api(`/api/orgs/${org.id}/settings/ai`, { method: "PUT", body: JSON.stringify({ ...form, clearSecrets: clear }) });
          setForm(null);
          setClear([]);
          await qc.invalidateQueries({ queryKey: ["org-ai-settings", org.id] });
          await qc.invalidateQueries({ queryKey: ["org-ai-status", org.id] });
          toast(t("org.saved"), "success");
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div>
        <h2 className="font-semibold">{t("org.title")}</h2>
        <p className="text-sm text-muted">{t("org.description")}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("org.title")}>
        {KINDS.filter((k) => k !== "folderpilot" || folderpilotAvailable || ai.provider === "folderpilot").map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={ai.provider === k}
            onClick={() => set({ provider: k })}
            className={cn("rounded-lg border px-3 py-1.5 text-sm", ai.provider === k ? "border-accent bg-accent-soft font-medium text-accent" : "hover:bg-surface-2")}
          >
            {t(`org.providers.${k}`)}
          </button>
        ))}
      </div>
      {!folderpilotAvailable && <p className="text-xs text-muted">{t("org.folderpilotUnavailable")}</p>}

      {ai.provider === "ollama" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("org.fields.baseUrl")}>
            <Input value={ai.ollama.baseUrl} onChange={(e) => set({ ollama: { ...ai.ollama, baseUrl: e.target.value } })} />
          </Field>
          <Field label={t("org.fields.visionModel")}>
            <Input value={ai.ollama.visionModel} onChange={(e) => set({ ollama: { ...ai.ollama, visionModel: e.target.value } })} />
          </Field>
          <Field label={t("org.fields.textModel")}>
            <Input value={ai.ollama.textModel} onChange={(e) => set({ ollama: { ...ai.ollama, textModel: e.target.value } })} />
          </Field>
          <Field label={t("org.fields.embedModel")}>
            <Input value={ai.ollama.embedModel} onChange={(e) => set({ ollama: { ...ai.ollama, embedModel: e.target.value } })} />
          </Field>
        </div>
      )}

      {ai.provider === "openai" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("org.fields.name")}>
            <Input value={ai.openai.name} onChange={(e) => set({ openai: { ...ai.openai, name: e.target.value } })} />
          </Field>
          <Field label={t("org.fields.baseUrl")}>
            <Input aria-label={t("org.fields.baseUrl")} value={ai.openai.baseUrl} onChange={(e) => set({ openai: { ...ai.openai, baseUrl: e.target.value } })} />
          </Field>
          <Field label={t("org.fields.apiKey")}>{secret("openai.apiKey", ai.openai.apiKey, (v) => set({ openai: { ...ai.openai, apiKey: v } }))}</Field>
          <Field label={t("org.fields.model")}>
            <Input aria-label={t("org.fields.model")} value={ai.openai.model} onChange={(e) => set({ openai: { ...ai.openai, model: e.target.value } })} />
          </Field>
        </div>
      )}

      {ai.provider === "anthropic" && (
        <div className="space-y-3">
          <Field label={t("org.platform")}>
            <select
              className="h-9 rounded-lg border bg-surface px-2 text-sm"
              value={ai.anthropic.platform}
              onChange={(e) => set({ anthropic: { ...ai.anthropic, platform: e.target.value as AISettings["anthropic"]["platform"] } })}
            >
              {(["anthropic", "bedrock", "vertex"] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`org.platforms.${p}`)}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("org.fields.name")}>
              <Input value={ai.anthropic.name} onChange={(e) => set({ anthropic: { ...ai.anthropic, name: e.target.value } })} />
            </Field>
            <Field label={t("org.fields.model")}>
              <Input value={ai.anthropic.model} onChange={(e) => set({ anthropic: { ...ai.anthropic, model: e.target.value } })} />
            </Field>
            {ai.anthropic.platform === "anthropic" && (
              <>
                <Field label={t("org.fields.baseUrl")}>
                  <Input value={ai.anthropic.baseUrl} onChange={(e) => set({ anthropic: { ...ai.anthropic, baseUrl: e.target.value } })} />
                </Field>
                <Field label={t("org.fields.apiKey")}>{secret("anthropic.apiKey", ai.anthropic.apiKey, (v) => set({ anthropic: { ...ai.anthropic, apiKey: v } }))}</Field>
              </>
            )}
            {ai.anthropic.platform === "bedrock" && (
              <>
                <Field label={t("org.fields.region")}>
                  <Input value={ai.anthropic.bedrock.region} onChange={(e) => set({ anthropic: { ...ai.anthropic, bedrock: { ...ai.anthropic.bedrock, region: e.target.value } } })} />
                </Field>
                <Field label={t("org.fields.accessKeyId")} hint={t("org.bedrockHint")}>
                  <Input value={ai.anthropic.bedrock.accessKeyId} onChange={(e) => set({ anthropic: { ...ai.anthropic, bedrock: { ...ai.anthropic.bedrock, accessKeyId: e.target.value } } })} />
                </Field>
                <Field label={t("org.fields.secretAccessKey")}>
                  {secret("anthropic.bedrock.secretAccessKey", ai.anthropic.bedrock.secretAccessKey, (v) => set({ anthropic: { ...ai.anthropic, bedrock: { ...ai.anthropic.bedrock, secretAccessKey: v } } }))}
                </Field>
              </>
            )}
            {ai.anthropic.platform === "vertex" && (
              <>
                <Field label={t("org.fields.projectId")}>
                  <Input value={ai.anthropic.vertex.projectId} onChange={(e) => set({ anthropic: { ...ai.anthropic, vertex: { ...ai.anthropic.vertex, projectId: e.target.value } } })} />
                </Field>
                <Field label={t("org.fields.region")}>
                  <Input value={ai.anthropic.vertex.region} onChange={(e) => set({ anthropic: { ...ai.anthropic, vertex: { ...ai.anthropic.vertex, region: e.target.value } } })} />
                </Field>
                <Field label={t("org.fields.serviceAccountJson")} hint={t("org.vertexHint")}>
                  {secret("anthropic.vertex.serviceAccountJson", ai.anthropic.vertex.serviceAccountJson, (v) => set({ anthropic: { ...ai.anthropic, vertex: { ...ai.anthropic.vertex, serviceAccountJson: v } } }))}
                </Field>
              </>
            )}
          </div>
        </div>
      )}

      <Field label={t("org.fields.budget")} hint={t("org.fields.budgetHint")}>
        <Input type="number" min={0} className="w-40" value={form.aiMonthlyFileBudget} onChange={(e) => setForm({ ...form, aiMonthlyFileBudget: Math.max(0, Number(e.target.value) || 0) })} />
      </Field>
      <div>
        <p className="text-xs text-muted">{t("org.usage", { files: usage.files, budget: form.aiMonthlyFileBudget, tokens: (usage.inputTokens + usage.outputTokens).toLocaleString() })}</p>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className={cn("h-full", usage.files >= form.aiMonthlyFileBudget ? "bg-danger" : "bg-accent")} style={{ width: `${Math.min(100, (usage.files / Math.max(1, form.aiMonthlyFileBudget)) * 100)}%` }} />
        </div>
      </div>

      <Field label={t("org.fields.autoRun")} hint={t("org.fields.autoRunHint")}>
        <Input
          type="number"
          min={0}
          max={1000}
          className="w-40"
          aria-label={t("org.fields.autoRun")}
          value={form.autoRun?.maxFiles ?? 0}
          onChange={(e) => setForm({ ...form, autoRun: { allowMcp: form.autoRun?.allowMcp ?? false, maxFiles: Math.min(1000, Math.max(0, Number(e.target.value) || 0)) } })}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          {t("org.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={test === "testing"}
          onClick={async () => {
            setTest("testing");
            try {
              setTest(await api<{ ok: boolean; message: string }>(`/api/orgs/${org.id}/settings/ai/test`, { method: "POST", body: "{}" }));
            } catch (err) {
              setTest({ ok: false, message: err instanceof Error ? err.message : String(err) });
            }
          }}
        >
          {test === "testing" && <Loader2 className="animate-spin" />}
          {t("org.test")}
        </Button>
        {test && test !== "testing" && (
          <span className={cn("flex items-center gap-1.5 text-sm", test.ok ? "text-success" : "text-danger")}>
            {test.ok ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4 shrink-0" />}
            {test.message}
          </span>
        )}
      </div>
    </form>
  );
}
