import { useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Cloud, Cpu, Loader2, Lock, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { db } from "@/lib/db";
import { createProvider } from "@/lib/ai";
import { recomputeFlags } from "@/lib/analysis/runner";
import { buildEmbeddings } from "@/lib/search";
import { saveSettings, useSettings, type AISettings, type ProviderKind, type Thresholds } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import { useUI } from "@/stores/ui";

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

const PROVIDERS: { kind: ProviderKind; title: string; text: string; icon: typeof Cpu }[] = [
  { kind: "none", title: "Off", text: "Local analysis only (duplicates, bad photos, keyword search).", icon: PowerOff },
  { kind: "ollama", title: "Local — Ollama", text: "Runs on this computer. Nothing leaves your machine.", icon: Cpu },
  { kind: "openai", title: "Your cloud — OpenAI-compatible", text: "OpenAI, Azure OpenAI, gateways, LM Studio, vLLM…", icon: Cloud },
  { kind: "anthropic", title: "Your cloud — Anthropic", text: "Claude API, or your Bedrock/Vertex proxy.", icon: Cloud },
];

export function TestConnection() {
  const settings = useSettings();
  const [state, setState] = useState<{ status: "idle" | "testing" | "ok" | "error"; message?: string }>({ status: "idle" });
  const provider = createProvider(settings.ai);
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
        Test connection
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
      {!provider && settings.ai.provider !== "none" && <span className="text-sm text-muted">Fill in the fields above first.</span>}
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const root = useActiveRoot();
  const { semanticSearch, setSemanticSearch } = useUI();
  const [embedding, setEmbedding] = useState<string | null>(null);
  const ai = settings.ai;
  const setAI = <K extends keyof AISettings>(key: K, value: AISettings[K]) => void saveSettings((s) => ({ ...s, ai: { ...s.ai, [key]: value } }));
  const setThreshold = (key: keyof Thresholds, value: number) => void saveSettings((s) => ({ ...s, thresholds: { ...s.thresholds, [key]: value } }));
  const provider = createProvider(ai);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="font-semibold">Settings</h1>

        <Section
          title="AI provider"
          description={
            <span className="flex items-center gap-1.5">
              <Lock className="size-3.5" /> Only thumbnails (max 512px) or extracted text are sent — never whole files. Keys stay in this browser.
            </span>
          }
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDERS.map(({ kind, title, text, icon: Icon }) => (
              <button
                key={kind}
                onClick={() => setAI("provider", kind)}
                className={cn("flex gap-3 rounded-lg border p-3 text-left transition-colors", ai.provider === kind ? "border-accent bg-accent-soft" : "hover:bg-surface-2")}
                aria-pressed={ai.provider === kind}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", ai.provider === kind ? "text-accent" : "text-muted")} />
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-muted">{text}</span>
                </span>
              </button>
            ))}
          </div>

          {ai.provider === "ollama" && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Ollama URL">
                  <Input value={ai.ollama.baseUrl} onChange={(e) => setAI("ollama", { ...ai.ollama, baseUrl: e.target.value })} />
                </Field>
                <Field label="Vision model" hint="For photos and screenshots">
                  <Input value={ai.ollama.visionModel} onChange={(e) => setAI("ollama", { ...ai.ollama, visionModel: e.target.value })} />
                </Field>
                <Field label="Text model" hint="For documents and the agent (needs tool support)">
                  <Input value={ai.ollama.textModel} onChange={(e) => setAI("ollama", { ...ai.ollama, textModel: e.target.value })} />
                </Field>
                <Field label="Embedding model" hint="For semantic search">
                  <Input value={ai.ollama.embedModel} onChange={(e) => setAI("ollama", { ...ai.ollama, embedModel: e.target.value })} />
                </Field>
              </div>
              <div className="rounded-lg bg-surface-2 p-3 text-xs">
                <p className="mb-1 font-medium">Allow FolderPilot to talk to Ollama (one time):</p>
                <p className="text-muted">Windows: set an environment variable, then restart Ollama.</p>
                <pre className="mt-1 overflow-x-auto rounded bg-surface p-2 font-mono">setx OLLAMA_ORIGINS "{location.origin}"</pre>
                <p className="mt-2 text-muted">Then pull the models:</p>
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
              <Field label="Display name" hint="Shown in the top bar">
                <Input value={ai.openai.name} onChange={(e) => setAI("openai", { ...ai.openai, name: e.target.value })} />
              </Field>
              <Field label="Base URL" hint="Ends in /v1 for most services">
                <Input value={ai.openai.baseUrl} onChange={(e) => setAI("openai", { ...ai.openai, baseUrl: e.target.value })} />
              </Field>
              <Field label="API key">
                <Input type="password" value={ai.openai.apiKey} onChange={(e) => setAI("openai", { ...ai.openai, apiKey: e.target.value })} autoComplete="off" />
              </Field>
              <Field label="Model" hint="Needs vision + tool calling">
                <Input value={ai.openai.model} onChange={(e) => setAI("openai", { ...ai.openai, model: e.target.value })} />
              </Field>
              <Field label="Embedding model" hint="Optional, for semantic search">
                <Input value={ai.openai.embedModel} onChange={(e) => setAI("openai", { ...ai.openai, embedModel: e.target.value })} />
              </Field>
            </div>
          )}

          {ai.provider === "anthropic" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Display name">
                <Input value={ai.anthropic.name} onChange={(e) => setAI("anthropic", { ...ai.anthropic, name: e.target.value })} />
              </Field>
              <Field label="Base URL" hint="https://api.anthropic.com, or your proxy">
                <Input value={ai.anthropic.baseUrl} onChange={(e) => setAI("anthropic", { ...ai.anthropic, baseUrl: e.target.value })} />
              </Field>
              <Field label="API key">
                <Input type="password" value={ai.anthropic.apiKey} onChange={(e) => setAI("anthropic", { ...ai.anthropic, apiKey: e.target.value })} autoComplete="off" />
              </Field>
              <Field label="Model" hint="e.g. claude-opus-5-5 or claude-haiku-5-5 (cheaper)">
                <Input value={ai.anthropic.model} onChange={(e) => setAI("anthropic", { ...ai.anthropic, model: e.target.value })} />
              </Field>
              <p className="text-xs text-muted sm:col-span-2">No embeddings with this provider, so search uses keywords.</p>
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
            Analyze new files with AI automatically after indexing
          </label>
        </Section>

        <Section title="Semantic search" description="Find files by meaning (“tax papers for the bakery”), not just by words. Needs a provider with embeddings.">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={!provider?.embed || !root || embedding !== null}
              onClick={async () => {
                if (!provider || !root) return;
                const model = ai.provider === "ollama" ? ai.ollama.embedModel : ai.openai.embedModel;
                setEmbedding("Starting…");
                try {
                  const n = await buildEmbeddings(root.id, provider, model, (d, t) => setEmbedding(`${d}/${t}`));
                  toast(`Semantic index updated (${n} files)`, "success");
                  setSemanticSearch(true);
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), "error");
                } finally {
                  setEmbedding(null);
                }
              }}
            >
              {embedding !== null && <Loader2 className="animate-spin" />}
              {embedding !== null ? `Indexing ${embedding}` : "Build / update semantic index"}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[rgb(var(--accent))]" checked={semanticSearch} onChange={(e) => setSemanticSearch(e.target.checked)} disabled={!provider?.embed} />
              Use semantic search in the search bar
            </label>
          </div>
        </Section>

        <Section title="Analysis thresholds" description="Tune what counts as a near-duplicate or a bad photo. Flags update right away.">
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["nearDuplicateDistance", "Near-duplicate distance (bits of 64)", 0, 16, 1],
                ["blur", "Blurry below (sharpness)", 5, 400, 5],
                ["dark", "Dark below (brightness 0–255)", 5, 120, 1],
                ["tiny", "Tiny below (px, longest side)", 50, 1000, 10],
                ["confidence", "Needs Review below (AI confidence)", 0.1, 0.95, 0.05],
              ] as const
            ).map(([key, label, min, max, step]) => (
              <Field key={key} label={`${label}: ${settings.thresholds[key]}`}>
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

        <Section title="Data" description="FolderPilot's index lives in this browser. Removing it never touches your files.">
          <Button
            variant="outline"
            size="sm"
            disabled={!root}
            onClick={async () => {
              if (!root || !confirm(`Forget “${root.name}”? Its index and pending plans are removed from FolderPilot (the audit log is kept). Your files stay exactly where they are.`)) return;
              await db.transaction("rw", [db.files, db.roots, db.plans, db.embeddings], async () => {
                await db.files.where("rootId").equals(root.id).delete();
                await db.plans.where("rootId").equals(root.id).delete();
                await db.embeddings.where("rootId").equals(root.id).delete();
                await db.roots.delete(root.id);
              });
              toast(`Forgot “${root.name}”`);
            }}
          >
            Forget this folder
          </Button>
        </Section>
      </div>
    </div>
  );
}
