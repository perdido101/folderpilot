import { describeMeta, insightSystemPrompt } from "./prompts";
import { parseInsight } from "./parse";
import type { AIProvider, AnalyzeContext, ChatMessage, ChatResult, FileMeta, ToolDef } from "./types";
import { blobToBase64, postJson, trimSlash } from "./util";
import type { AISettings } from "../settings";

type Content = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: Content | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface CompletionResponse {
  choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(args || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Any OpenAI-compatible endpoint: OpenAI, Azure OpenAI, gateways, LM Studio, vLLM… */
export class OpenAICompatibleProvider implements AIProvider {
  readonly label: string;
  private readonly base: string;

  constructor(private readonly cfg: AISettings["openai"]) {
    this.base = trimSlash(cfg.baseUrl);
    this.label = `Your cloud: ${cfg.name || "OpenAI-compatible"}`;
  }

  private headers(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}`, "api-key": this.cfg.apiKey } : {};
  }

  private async complete(messages: WireMessage[], extra: Record<string, unknown> = {}) {
    const res = await postJson<CompletionResponse>(`${this.base}/chat/completions`, { model: this.cfg.model, messages, ...extra }, this.headers());
    const choice = res.choices[0];
    if (!choice) throw new Error("Empty response from AI endpoint");
    return choice.message;
  }

  async describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext) {
    const url = `data:${thumb.type || "image/jpeg"};base64,${await blobToBase64(thumb)}`;
    const msg = await this.complete(
      [
        { role: "system", content: insightSystemPrompt(ctx) },
        { role: "user", content: [{ type: "text", text: describeMeta(meta) }, { type: "image_url", image_url: { url } }] },
      ],
      { response_format: { type: "json_object" } },
    );
    return parseInsight(msg.content ?? "");
  }

  async describeText(text: string, meta: FileMeta, ctx: AnalyzeContext) {
    const msg = await this.complete(
      [
        { role: "system", content: insightSystemPrompt(ctx) },
        { role: "user", content: `${describeMeta(meta)}\n\nExtracted text:\n${text || "(none)"}` },
      ],
      { response_format: { type: "json_object" } },
    );
    return parseInsight(msg.content ?? "");
  }

  async chat(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
    const wire: WireMessage[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") wire.push({ role: "user", content: m.content });
      else if (m.role === "assistant")
        wire.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls?.length
            ? m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } }))
            : undefined,
        });
      else wire.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
    const msg = await this.complete(wire, {
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    });
    return {
      content: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })),
    };
  }

  async embed(texts: string[]) {
    const res = await postJson<{ data: { embedding: number[]; index: number }[] }>(
      `${this.base}/embeddings`,
      { model: this.cfg.embedModel, input: texts },
      this.headers(),
    );
    return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async test() {
    const msg = await this.complete([{ role: "user", content: "Reply with the single word OK." }]);
    return `Connected · ${this.cfg.model} replied “${(msg.content ?? "").trim().slice(0, 20)}”`;
  }
}
