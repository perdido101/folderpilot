import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { describeMeta, insightSystemPrompt } from "./prompts";
import { parseInsight } from "./parse";
import { AIError, type AIProvider, type AnalyzeContext, type ChatEvent, type ChatMessage, type ChatOpts, type FileMeta, type InsightResult, type ToolDef, type Usage } from "./types";
import { blobToBase64, trimSlash } from "./util";
import type { AISettings } from "./config";

/** Wire schema for structured output (constraints are re-checked by parseInsight). */
const InsightWire = z.object({
  category: z.string(),
  tags: z.array(z.string()),
  caption: z.string(),
  suggestedName: z.string(),
  entities: z.object({ client: z.string().nullable(), date: z.string().nullable(), amount: z.string().nullable(), docType: z.string().nullable() }),
  confidence: z.number(),
  reason: z.string(),
});

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** The part of an Anthropic client we use; the Bedrock (Mantle) and Vertex clients expose the same surface. */
export type AnthropicClientLike = Pick<Anthropic, "beta">;

/** Models that accept server-side refusal fallbacks (Claude API only). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export interface AnthropicProviderOptions {
  client: AnthropicClientLike;
  /** Model for file analysis. */
  model: string;
  /** Model for the agent chat (defaults to `model`). */
  chatModel?: string;
  label: string;
  cacheKeyPrefix: string;
  /** Only on the first-party Claude API (not Bedrock/Vertex/proxies). */
  serverFallbacks: boolean;
}

const usageOf = (u: { input_tokens: number; output_tokens: number }): Usage => ({ inputTokens: u.input_tokens, outputTokens: u.output_tokens });

/** Claude through the Anthropic SDK: the Claude API, a proxy, Bedrock, Vertex, or FolderPilot AI (our key, server-side). */
export class AnthropicProvider implements AIProvider {
  readonly label: string;
  readonly cacheKey: string;
  private readonly client: AnthropicClientLike;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.client = opts.client;
    this.label = opts.label;
    this.cacheKey = `${opts.cacheKeyPrefix}:${opts.model}`;
  }

  /** A customer's own Claude API key, called directly (also from the browser). */
  static direct(cfg: AISettings["anthropic"]): AnthropicProvider {
    const baseURL = trimSlash(cfg.baseUrl || "https://api.anthropic.com");
    // dangerouslyAllowBrowser sends `anthropic-dangerous-direct-browser-access: true`; the key is the user's own.
    const client = new Anthropic({ apiKey: cfg.apiKey, baseURL, dangerouslyAllowBrowser: true });
    return new AnthropicProvider({
      client,
      model: cfg.model,
      label: `Your cloud: ${cfg.name || "Claude"}`,
      cacheKeyPrefix: "anthropic",
      serverFallbacks: new URL(baseURL).hostname === "api.anthropic.com",
    });
  }

  private fallback(model: string) {
    return this.opts.serverFallbacks && FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
  }

  private async insight(content: Anthropic.Beta.BetaContentBlockParam[], ctx: AnalyzeContext): Promise<InsightResult> {
    const model = this.opts.model;
    const res = await this.client.beta.messages.parse({
      model,
      max_tokens: 16000,
      system: insightSystemPrompt(ctx),
      messages: [{ role: "user", content }],
      output_config: { format: betaZodOutputFormat(InsightWire), effort: "low" },
      ...this.fallback(model),
    });
    if (res.stop_reason === "refusal") throw new AIError("The model declined to describe this file.");
    if (!res.parsed_output) throw new AIError("The model didn't return valid JSON.");
    return { insight: parseInsight(res.parsed_output), usage: usageOf(res.usage), model: res.model };
  }

  async describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext) {
    const media = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(thumb.type) ? thumb.type : "image/jpeg") as ImageMediaType;
    return this.insight(
      [
        { type: "image", source: { type: "base64", media_type: media, data: await blobToBase64(thumb) } },
        { type: "text", text: describeMeta(meta) },
      ],
      ctx,
    );
  }

  async describeText(text: string, meta: FileMeta, ctx: AnalyzeContext) {
    return this.insight([{ type: "text", text: `${describeMeta(meta)}\n\nExtracted text:\n${text || "(none)"}` }], ctx);
  }

  async *chat(system: string, messages: ChatMessage[], tools: ToolDef[], opts: ChatOpts = {}): AsyncGenerator<ChatEvent> {
    const wire: Anthropic.Beta.BetaMessageParam[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        wire.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        // Replay the model's own content blocks unchanged (thinking blocks included).
        wire.push({ role: "assistant", content: (m.raw as Anthropic.Beta.BetaContentBlockParam[] | undefined) ?? m.content });
      } else {
        const block: Anthropic.Beta.BetaToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError };
        const last = wire.at(-1);
        // All results for one assistant turn go back in a single user message.
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
        else wire.push({ role: "user", content: [block] });
      }
    }
    const model = this.opts.chatModel ?? this.opts.model;
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        system,
        ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema })) } : {}),
        messages: wire,
        output_config: { effort: "medium" },
        ...this.fallback(model),
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
    }
    const res = await stream.finalMessage();
    if (res.stop_reason === "refusal") throw new AIError("The model declined this request.");
    const toolCalls = res.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []));
    if (res.stop_reason === "max_tokens" && toolCalls.length) throw new AIError("The reply was cut off before the tool call finished.");
    const content = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    yield { type: "done", content, toolCalls, raw: res.content, usage: usageOf(res.usage), model: res.model };
  }

  async test() {
    const model = this.opts.model;
    const res = await this.client.beta.messages.create({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      output_config: { effort: "low" },
      ...this.fallback(model),
    });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return `Connected · ${res.model} replied “${text.trim().slice(0, 20)}”`;
  }
}
