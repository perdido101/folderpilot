import type { AISettings } from "./config";
import { AnthropicProvider } from "./anthropic";
import { FolderPilotProvider } from "./folderpilot";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai";
import type { AIProvider } from "./types";

export interface BrowserProviderContext {
  /** Signed-in organization, required for FolderPilot AI (it runs through our API). */
  orgId?: string | null;
  apiBase?: string;
}

/**
 * Providers the browser can call directly. Bedrock and Vertex need cloud credentials and only run on the server,
 * so they are configured for the organization (server spaces), not for a folder on this device.
 */
export function createProvider(ai: AISettings, ctx: BrowserProviderContext = {}): AIProvider | null {
  switch (ai.provider) {
    case "folderpilot":
      return ctx.orgId ? new FolderPilotProvider({ apiBase: ctx.apiBase ?? "", orgId: ctx.orgId }) : null;
    case "ollama":
      return new OllamaProvider(ai.ollama);
    case "openai":
      return ai.openai.baseUrl && ai.openai.model ? new OpenAICompatibleProvider(ai.openai) : null;
    case "anthropic":
      return ai.anthropic.platform === "anthropic" && ai.anthropic.apiKey && ai.anthropic.model ? AnthropicProvider.direct(ai.anthropic) : null;
    default:
      return null;
  }
}

export * from "./types";
export * from "./config";
export * from "./parse";
export * from "./prompts";
export { AnthropicProvider, FolderPilotProvider, OllamaProvider, OpenAICompatibleProvider };
export type { AnthropicClientLike, AnthropicProviderOptions } from "./anthropic";
export * from "./rules";
export * from "./agent";
