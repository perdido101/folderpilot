import type { AISettings } from "./config";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai";
import type { AIProvider } from "./types";

export function createProvider(ai: AISettings): AIProvider | null {
  switch (ai.provider) {
    case "ollama":
      return new OllamaProvider(ai.ollama);
    case "openai":
      return ai.openai.baseUrl && ai.openai.model ? new OpenAICompatibleProvider(ai.openai) : null;
    case "anthropic":
      return ai.anthropic.apiKey && ai.anthropic.model ? new AnthropicProvider(ai.anthropic) : null;
    default:
      return null;
  }
}

export * from "./types";
export * from "./config";
export * from "./parse";
export * from "./prompts";
export { AnthropicProvider, OllamaProvider, OpenAICompatibleProvider };
