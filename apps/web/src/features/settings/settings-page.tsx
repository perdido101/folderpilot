import { useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Cloud, Cpu, Loader2, Lock, PowerOff, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { Input } from "@folderpilot/ui";
import { db } from "@/lib/db";
import { useBrowserProvider } from "@/lib/ai/provider";
import { recomputeFlags } from "@/lib/analysis/runner";
import { buildEmbeddings } from "@/lib/search";
import { saveSettings, useSettings, type AISettings, type ProviderKind, type Thresholds } from "@/lib/settings";
import { cn } from "@folderpilot/ui";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import { useUI } from "@/stores/ui";
import { useMode } from "@/stores/mode";
import { useActiveOrg, useFeatures } from "@/hooks/use-me";
import { OrgAISettings } from "./org-ai-settings";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-lg border bg-surface p-5">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

const PROVIDERS: { kind: ProviderKind; icon: typeof Cpu }[] = [
  { kind: "none", icon: PowerOff },
  { kind: "folderpilot", icon: Sparkles },
  { kind: "ollama", icon: Cpu },
  { kind: "openai", icon: Cloud },
  { kind: "anthropic", icon: Cloud },
];

export function TestConnection() {
  const settings = useSettings();
  const { t } = useTranslation("settings");
  const [state, setState] = useState<{ status: "idle" | "testing" | "ok" | "error"; message?: string }>({ status: "idle" });
  const provider = useBrowserProvider(settings.ai);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={!provider || state.status === "testing"}
        onClick={async () => {
          setState({ status: "testing" });
          try {
            setState({ status: "ok", message: await provider!.test() });
          } catch (err) {
            setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
          }
        }}
      >
        {state.status === "testing" && <Loader2 className="animate-spin" />}
        {t("test.button")}
      </Button>
      {state.status === "ok" && (
        <span className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" />
          {state.message}
        </span>
      )}
      {state.status === "error" && (
        <span className="flex items-center gap-1.5 text-sm text-danger">
          <CircleAlert className="size-4 shrink-0" />
          {state.message}
        </span>
      )}
      {!provider && settings.ai.provider !== "none" && <span className="text-sm text-muted">{t("test.fillFieldsFirst")}</span>}
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const { t } = useTranslation("settings");
  const root = useActiveRoot();
  const { semanticSearch, setSemanticSearch } = useUI();
  const [embedding, setEmbedding] = useState<string | null>(null);
  const ai = settings.ai;
  const setAI = <K extends keyof AISettings>(key: K, value: AISettings[K]) => void saveSettings((s) => ({ ...s, ai: { ...s.ai, [key]: value } }));
  const setThreshold = (key: keyof Thresholds, value: number) => void saveSettings((s) => ({ ...s, thresholds: { ...s.thresholds, [key]: value } }));
  const provider = useBrowserProvider(ai);
  const mode = useMode((s) => s.mode);
  const org = useActiveOrg();
  const features = useFeatures().data;
  // FolderPilot AI runs through our API, so it needs a signed-in organization and the server's key.
  const providers = PROVIDERS.filter((p) => p.kind !== "folderpilot" || (mode === "account" && org && features?.folderpilotAI) || ai.provider === "folderpilot");

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="font-semibold">{t("title")}</h1>
        {mode === "account" && <OrgAISettings />}

        <Section
          title={mode === "account" ? t("org.deviceTitle") : t("provider.title")}
          description={
            <span className="flex items-center gap-1.5">
              <Lock className="size-3.5" /> {t("provider.privacy")}
            </span>
          }
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {providers.map(({ kind, icon: Icon }) => (
              <button
                key={kind}
                onClick={() => setAI("provider", kind)}
                className={cn(
                  "flex gap-3 rounded-lg border p-3 text-left transition-colors",
                  ai.provider === kind ? "border-accent bg-accent-soft" : "hover:bg-surface-2",
                )}
                aria-pressed={ai.provider === kind}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", ai.provider === kind ? "text-accent" : "text-muted")} />
                <span>
                  <span className="block text-sm font-medium">{t(`provider.options.${kind}.title`)}</span>
                  <span className="block text-xs text-muted">{t(`provider.options.${kind}.text`)}</span>
                </span>
              </button>
            ))}
          </div>

          {ai.provider === "ollama" && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("fields.ollamaUrl")}>
                  <Input value={ai.ollama.baseUrl} onChange={(e) => setAI("ollama", { ...ai.ollama, baseUrl: e.target.value })} />
                </Field>
                <Field label={t("fields.visionModel")} hint={t("fields.visionModelHint")}>
                  <Input value={ai.ollama.visionModel} onChange={(e) => setAI("ollama", { ...ai.ollama, visionModel: e.target.value })} />
                </Field>
                <Field label={t("fields.textModel")} hint={t("fields.textModelHint")}>
                  <Input value={ai.ollama.textModel} onChange={(e) => setAI("ollama", { ...ai.ollama, textModel: e.target.value })} />
                </Field>
                <Field label={t("fields.embedModel")} hint={t("fields.embedModelHint")}>
                  <Input value={ai.ollama.embedModel} onChange={(e) => setAI("ollama", { ...ai.ollama, embedModel: e.target.value })} />
                </Field>
              </div>
              <div className="rounded-lg bg-surface-2 p-3 text-xs">
                <p className="mb-1 font-medium">{t("ollamaSetup.title")}</p>
                <p className="text-muted">{t("ollamaSetup.windows")}</p>
                <pre className="mt-1 overflow-x-auto rounded bg-surface p-2 font-mono">setx OLLAMA_ORIGINS "{location.origin}"</pre>
                <p className="mt-2 text-muted">{t("ollamaSetup.pull")}</p>
                <pre className="mt-1 overflow-x-auto rounded bg-surface p-2 font-mono">
                  ollama pull {ai.ollama.visionModel}
                  {"\n"}ollama pull {ai.ollama.textModel}
                  {"\n"}ollama pull {ai.ollama.embedModel}
                </pre>
              </div>
            </div>
          )}

          {ai.provider === "openai" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("fields.displayName")} hint={t("fields.displayNameHint")}>
                <Input value={ai.openai.name} onChange={(e) => setAI("openai", { ...ai.openai, name: e.target.value })} />
              </Field>
              <Field label={t("fields.baseUrl")} hint={t("fields.baseUrlOpenAIHint")}>
                <Input value={ai.openai.baseUrl} onChange={(e) => setAI("openai", { ...ai.openai, baseUrl: e.target.value })} />
              </Field>
              <Field label={t("fields.apiKey")}>
                <Input
                  type="password"
                  value={ai.openai.apiKey}
                  onChange={(e) => setAI("openai", { ...ai.openai, apiKey: e.target.value })}
                  autoComplete="off"
                />
              </Field>
              <Field label={t("fields.model")} hint={t("fields.modelOpenAIHint")}>
                <Input value={ai.openai.model} onChange={(e) => setAI("openai", { ...ai.openai, model: e.target.value })} />
              </Field>
              <Field label={t("fields.embedModel")} hint={t("fields.embedModelOptionalHint")}>
                <Input value={ai.openai.embedModel} onChange={(e) => setAI("openai", { ...ai.openai, embedModel: e.target.value })} />
              </Field>
            </div>
          )}

          {ai.provider === "anthropic" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("fields.displayName")}>
                <Input value={ai.anthropic.name} onChange={(e) => setAI("anthropic", { ...ai.anthropic, name: e.target.value })} />
              </Field>
              <Field label={t("fields.baseUrl")} hint={t("fields.baseUrlAnthropicHint")}>
                <Input value={ai.anthropic.baseUrl} onChange={(e) => setAI("anthropic", { ...ai.anthropic, baseUrl: e.target.value })} />
              </Field>
              <Field label={t("fields.apiKey")}>
                <Input
                  type="password"
                  value={ai.anthropic.apiKey}
                  onChange={(e) => setAI("anthropic", { ...ai.anthropic, apiKey: e.target.value })}
                  autoComplete="off"
                />
              </Field>
              <Field label={t("fields.model")} hint={t("fields.modelAnthropicHint")}>
                <Input value={ai.anthropic.model} onChange={(e) => setAI("anthropic", { ...ai.anthropic, model: e.target.value })} />
              </Field>
              <p className="text-xs text-muted sm:col-span-2">{t("fields.anthropicNoEmbeddings")}</p>
            </div>
          )}

          {ai.provider !== "none" && <TestConnection />}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[rgb(var(--accent))]"
              checked={settings.autoAnalyzeWithAI}
              onChange={(e) => void saveSettings((s) => ({ ...s, autoAnalyzeWithAI: e.target.checked }))}
            />
            {t("provider.autoAnalyze")}
          </label>
        </Section>

        <Section title={t("semantic.title")} description={t("semantic.description")}>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={!provider?.embed || !root || embedding !== null}
              onClick={async () => {
                if (!provider || !root) return;
                const model = ai.provider === "ollama" ? ai.ollama.embedModel : ai.openai.embedModel;
                setEmbedding(t("semantic.starting"));
                try {
                  const n = await buildEmbeddings(root.id, provider, model, (d, t) => setEmbedding(`${d}/${t}`));
                  toast(t("semantic.updated", { count: n }), "success");
                  setSemanticSearch(true);
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), "error");
                } finally {
                  setEmbedding(null);
                }
              }}
            >
              {embedding !== null && <Loader2 className="animate-spin" />}
              {embedding !== null ? t("semantic.indexing", { progress: embedding }) : t("semantic.build")}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[rgb(var(--accent))]"
                checked={semanticSearch}
                onChange={(e) => setSemanticSearch(e.target.checked)}
                disabled={!provider?.embed}
              />
              {t("semantic.useInSearch")}
            </label>
          </div>
        </Section>

        <Section title={t("thresholds.title")} description={t("thresholds.description")}>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["nearDuplicateDistance", 0, 16, 1],
                ["blur", 5, 400, 5],
                ["dark", 5, 120, 1],
                ["tiny", 50, 1000, 10],
                ["confidence", 0.1, 0.95, 0.05],
              ] as const
            ).map(([key, min, max, step]) => (
              <Field key={key} label={t("thresholds.value", { label: t(`thresholds.${key}`), value: settings.thresholds[key] })}>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={settings.thresholds[key]}
                  onChange={(e) => setThreshold(key, Number(e.target.value))}
                  onPointerUp={() => root && void recomputeFlags(root.id)}
                  onKeyUp={() => root && void recomputeFlags(root.id)}
                  className="w-full accent-[rgb(var(--accent))]"
                />
              </Field>
            ))}
          </div>
        </Section>

        <Section title={t("data.title")} description={t("data.description")}>
          <Button
            variant="outline"
            size="sm"
            disabled={!root}
            onClick={async () => {
              if (!root || !confirm(t("data.forgetConfirm", { name: root.name }))) return;
              await db.transaction("rw", [db.files, db.roots, db.plans, db.embeddings, db.trash], async () => {
                // Only FolderPilot's own index of this folder is forgotten; files on disk and the audit log stay.
                await db.files.where("rootId").equals(root.id).delete();
                await db.trash.where("rootId").equals(root.id).delete();
                await db.plans.where("rootId").equals(root.id).delete();
                await db.embeddings.where("rootId").equals(root.id).delete();
                await db.roots.delete(root.id);
              });
              toast(t("data.forgotten", { name: root.name }));
            }}
          >
            {t("data.forget")}
          </Button>
        </Section>
      </div>
    </div>
  );
}
