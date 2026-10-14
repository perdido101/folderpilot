/**
 * Server-only providers (Node): FolderPilot AI with our key, and a customer's Claude on Amazon Bedrock or Google Vertex AI.
 * Import from "@folderpilot/ai/server" — never from browser code.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";
import { AnthropicProvider, type AnthropicClientLike } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai";
import type { AISettings } from "./config";
import type { AIProvider } from "./types";

export interface HostedAIConfig {
  /** Our ANTHROPIC_API_KEY; FolderPilot AI is unavailable without it. */
  apiKey?: string | undefined;
  /** Small, fast model for file analysis (FP_AI_ANALYSIS_MODEL). */
  analysisModel: string;
  /** Stronger model for the agent (FP_AI_AGENT_MODEL). */
  agentModel: string;
}

export function folderPilotAI(hosted: HostedAIConfig): AnthropicProvider | null {
  if (!hosted.apiKey) return null;
  return new AnthropicProvider({
    client: new Anthropic({ apiKey: hosted.apiKey }),
    model: hosted.analysisModel,
    chatModel: hosted.agentModel,
    label: "FolderPilot AI",
    cacheKeyPrefix: "folderpilot",
    serverFallbacks: true,
  });
}

/**
 * Build the SDK client on first use. Cloud SDK clients start loading credentials as soon as they're constructed;
 * deferring that to the first request keeps a misconfigured provider from failing anything but its own calls.
 */
function lazyClient(create: () => AnthropicClientLike): AnthropicClientLike {
  let client: AnthropicClientLike | null = null;
  return {
    get beta() {
      return (client ??= create()).beta;
    },
  } as AnthropicClientLike;
}

/** Bedrock model ids carry an "anthropic." prefix. */
export const bedrockModelId = (model: string) => (model.startsWith("anthropic.") ? model : `anthropic.${model}`);

function customerClaude(cfg: AISettings["anthropic"]): AnthropicProvider | null {
  const label = `Your cloud: ${cfg.name || "Claude"}`;
  switch (cfg.platform) {
    case "bedrock": {
      const { region, accessKeyId, secretAccessKey } = cfg.bedrock;
      if (!region) return null;
      const client = lazyClient(
        () =>
          new AnthropicBedrockMantle({
            awsRegion: region,
            ...(accessKeyId && secretAccessKey ? { awsAccessKey: accessKeyId, awsSecretAccessKey: secretAccessKey } : {}),
          }) as unknown as AnthropicClientLike,
      );
      return new AnthropicProvider({ client, model: bedrockModelId(cfg.model), label, cacheKeyPrefix: "bedrock", serverFallbacks: false });
    }
    case "vertex": {
      const { projectId, region, serviceAccountJson } = cfg.vertex;
      if (!projectId || !region) return null;
      const client = lazyClient(() => {
        const googleAuth = new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          ...(serviceAccountJson ? { credentials: JSON.parse(serviceAccountJson) as Record<string, string> } : {}),
        });
        return new AnthropicVertex({ projectId, region, googleAuth }) as unknown as AnthropicClientLike;
      });
      return new AnthropicProvider({ client, model: cfg.model, label, cacheKeyPrefix: "vertex", serverFallbacks: false });
    }
    default: {
      if (!cfg.apiKey || !cfg.model) return null;
      const baseURL = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
      return new AnthropicProvider({
        client: new Anthropic({ apiKey: cfg.apiKey, baseURL }),
        model: cfg.model,
        label,
        cacheKeyPrefix: "anthropic",
        serverFallbacks: new URL(baseURL).hostname === "api.anthropic.com",
      });
    }
  }
}

/** The provider an organization configured, built on the server (settings already decrypted). */
export function createServerProvider(ai: AISettings, hosted: HostedAIConfig): AIProvider | null {
  switch (ai.provider) {
    case "folderpilot":
      return folderPilotAI(hosted);
    case "ollama":
      return new OllamaProvider(ai.ollama);
    case "openai":
      return ai.openai.baseUrl && ai.openai.model ? new OpenAICompatibleProvider(ai.openai) : null;
    case "anthropic":
      return customerClaude(ai.anthropic);
    default:
      return null;
  }
}
