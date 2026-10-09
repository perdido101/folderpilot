import type { AppSettings } from "../settings";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai";
import type { AIProvider } from "./types";

export function createProvider(ai: AppSettings["ai"]): AIProvider | null {
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

export type { AIProvider } from "./types";
