export type ProviderKind = "none" | "folderpilot" | "ollama" | "openai" | "anthropic";
/** Where a customer's own Claude runs. Bedrock and Vertex need cloud credentials, so they only run on the server. */
export type AnthropicPlatform = "anthropic" | "bedrock" | "vertex";

/**
 * AI provider configuration (per org on the server, per browser in device mode).
 * Secret fields (`apiKey`, Bedrock keys, Vertex service account) are stored encrypted and never sent back to the browser.
 */
export interface AISettings {
  provider: ProviderKind;
  ollama: { baseUrl: string; visionModel: string; textModel: string; embedModel: string };
  openai: { name: string; baseUrl: string; apiKey: string; model: string; embedModel: string };
  anthropic: {
    name: string;
    platform: AnthropicPlatform;
    baseUrl: string;
    apiKey: string;
    model: string;
    bedrock: { region: string; accessKeyId: string; secretAccessKey: string };
    vertex: { projectId: string; region: string; serviceAccountJson: string };
  };
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "none",
  ollama: { baseUrl: "http://localhost:11434", visionModel: "llava:7b", textModel: "llama3.2:3b", embedModel: "nomic-embed-text" },
  openai: { name: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini", embedModel: "text-embedding-3-small" },
  anthropic: {
    name: "Claude",
    platform: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    model: "claude-opus-5-5",
    bedrock: { region: "eu-central-1", accessKeyId: "", secretAccessKey: "" },
    vertex: { projectId: "", region: "global", serviceAccountJson: "" },
  },
};

/** Paths of the secret fields, so the server can strip/encrypt them. */
export const AI_SECRET_FIELDS = ["openai.apiKey", "anthropic.apiKey", "anthropic.bedrock.secretAccessKey", "anthropic.vertex.serviceAccountJson"] as const;

/** Fill in fields missing from older saved settings. */
export function withDefaults(partial: Partial<AISettings> | undefined): AISettings {
  const p = partial ?? {};
  const a = (p.anthropic ?? {}) as Partial<AISettings["anthropic"]>;
  return {
    provider: p.provider ?? DEFAULT_AI_SETTINGS.provider,
    ollama: { ...DEFAULT_AI_SETTINGS.ollama, ...p.ollama },
    openai: { ...DEFAULT_AI_SETTINGS.openai, ...p.openai },
    anthropic: {
      ...DEFAULT_AI_SETTINGS.anthropic,
      ...a,
      bedrock: { ...DEFAULT_AI_SETTINGS.anthropic.bedrock, ...a.bedrock },
      vertex: { ...DEFAULT_AI_SETTINGS.anthropic.vertex, ...a.vertex },
    },
  };
}
