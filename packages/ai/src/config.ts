export type ProviderKind = "none" | "ollama" | "openai" | "anthropic";

/** Per-org (or per-space) AI provider configuration. Keys stay with the user/org, encrypted at rest on the server. */
export interface AISettings {
  provider: ProviderKind;
  ollama: { baseUrl: string; visionModel: string; textModel: string; embedModel: string };
  openai: { name: string; baseUrl: string; apiKey: string; model: string; embedModel: string };
  anthropic: { name: string; baseUrl: string; apiKey: string; model: string };
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "none",
  ollama: { baseUrl: "http://localhost:11434", visionModel: "llava:7b", textModel: "llama3.2:3b", embedModel: "nomic-embed-text" },
  openai: { name: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini", embedModel: "text-embedding-3-small" },
  anthropic: { name: "Claude", baseUrl: "https://api.anthropic.com", apiKey: "", model: "claude-opus-5-5" },
};
