import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { describeMeta, insightSystemPrompt } from "./prompts";
import { parseInsight } from "./parse";
import { AIError, type AIProvider, type AnalyzeContext, type ChatMessage, type ChatResult, type FileMeta, type ToolDef } from "./types";
import { blobToBase64, trimSlash } from "./util";
import type { AISettings } from "../settings";

/** Wire schema for structured output (constraints are re-checked by parseInsight). */
const InsightWire = z.object({
  category: z.string(),
  tags: z.array(z.string()),
  caption: z.string(),
  suggestedName: z.string(),
  client: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
});

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Claude API (or a Bedrock/Vertex proxy that speaks the Messages API), called directly from the browser. */
export class AnthropicProvider implements AIProvider {
  readonly label: string;
  private readonly client: Anthropic;
  /** Server-side refusal fallbacks are only available on the first-party Claude API. */
  private readonly fallback: { betas: string[]; fallbacks: "default" } | Record<string, never>;

  constructor(private readonly cfg: AISettings["anthropic"]) {
    const baseURL = trimSlash(cfg.baseUrl || "https://api.anthropic.com");
    this.label = `Your cloud: ${cfg.name || "Claude"}`;
    // dangerouslyAllowBrowser sends `anthropic-dangerous-direct-browser-access: true`.
    // The key is the user's own and stays in this browser (IndexedDB).
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL, dangerouslyAllowBrowser: true });
    this.fallback = new URL(baseURL).hostname === "api.anthropic.com" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
  }

  private async insight(content: Anthropic.Beta.BetaContentBlockParam[], ctx: AnalyzeContext) {
    const res = await this.client.beta.messages.parse({
      model: this.cfg.model,
      max_tokens: 16000,
      system: insightSystemPrompt(ctx),
      messages: [{ role: "user", content }],
      output_config: { format: betaZodOutputFormat(InsightWire), effort: "low" },
      ...this.fallback,
    });
    if (res.stop_reason === "refusal") throw new AIError("The model declined to describe this file.");
    if (!res.parsed_output) throw new AIError("The model didn't return valid JSON.");
    return parseInsight(res.parsed_output);
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

  async chat(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
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
    const res = await this.client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: 16000,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema })),
      messages: wire,
      output_config: { effort: "medium" },
      ...this.fallback,
    });
    if (res.stop_reason === "refusal") throw new AIError("The model declined this request.");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const toolCalls = res.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []));
    return { content: text, toolCalls, raw: res.content };
  }

  async test() {
    const res = await this.client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      output_config: { effort: "low" },
      ...this.fallback,
    });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return `Connected · ${res.model} replied “${text.trim().slice(0, 20)}”`;
  }
}
