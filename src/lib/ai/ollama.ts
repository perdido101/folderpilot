import { describeMeta, insightSystemPrompt } from "./prompts";
import { parseInsight } from "./parse";
import type { AIProvider, AnalyzeContext, ChatMessage, ChatResult, FileMeta, ToolDef } from "./types";
import { blobToBase64, newCallId, postJson, trimSlash } from "./util";
import type { AISettings } from "../settings";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message: OllamaMessage;
}

export class OllamaProvider implements AIProvider {
  readonly label = "Local AI";
  private readonly base: string;

  constructor(private readonly cfg: AISettings["ollama"]) {
    this.base = trimSlash(cfg.baseUrl);
  }

  private async complete(model: string, messages: OllamaMessage[], extra: Record<string, unknown> = {}) {
    return postJson<OllamaChatResponse>(`${this.base}/api/chat`, { model, messages, stream: false, ...extra });
  }

  async describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext) {
    const res = await this.complete(
      this.cfg.visionModel,
      [
        { role: "system", content: insightSystemPrompt(ctx) },
        { role: "user", content: describeMeta(meta), images: [await blobToBase64(thumb)] },
      ],
      { format: "json", options: { temperature: 0.2 } },
    );
    return parseInsight(res.message.content);
  }

  async describeText(text: string, meta: FileMeta, ctx: AnalyzeContext) {
    const res = await this.complete(
      this.cfg.textModel,
      [
        { role: "system", content: insightSystemPrompt(ctx) },
        { role: "user", content: `${describeMeta(meta)}\n\nExtracted text:\n${text || "(none)"}` },
      ],
      { format: "json", options: { temperature: 0.2 } },
    );
    return parseInsight(res.message.content);
  }

  async chat(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
    const wire: OllamaMessage[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") wire.push({ role: "user", content: m.content });
      else if (m.role === "assistant")
        wire.push({ role: "assistant", content: m.content, tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.name, arguments: c.input } })) });
      else wire.push({ role: "tool", content: m.content, tool_name: m.name });
    }
    const res = await this.complete(this.cfg.textModel, wire, {
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    });
    return {
      content: res.message.content ?? "",
      toolCalls: (res.message.tool_calls ?? []).map((c) => ({ id: newCallId(), name: c.function.name, input: c.function.arguments ?? {} })),
    };
  }

  async embed(texts: string[]) {
    const res = await postJson<{ embeddings: number[][] }>(`${this.base}/api/embed`, { model: this.cfg.embedModel, input: texts });
    return res.embeddings;
  }

  async test() {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/tags`);
    } catch {
      throw new Error(`Can't reach Ollama at ${this.base}. Start Ollama and set OLLAMA_ORIGINS to allow ${location.origin}.`);
    }
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const { models } = (await res.json()) as { models: { name: string }[] };
    const names = models.map((m) => m.name);
    const missing = [this.cfg.visionModel, this.cfg.textModel].filter((m) => !names.some((n) => n === m || n.startsWith(`${m}:`)));
    if (missing.length) throw new Error(`Connected, but these models aren't pulled yet: ${missing.join(", ")} (run: ollama pull ${missing[0]})`);
    return `Connected · ${names.length} models available`;
  }
}
