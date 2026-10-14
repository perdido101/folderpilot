import { describeMeta, insightSystemPrompt } from "./prompts";
import { parseInsight } from "./parse";
import type { AIProvider, AnalyzeContext, ChatEvent, ChatMessage, ChatOpts, FileMeta, InsightResult, ToolCall, ToolDef, Usage } from "./types";
import { blobToBase64, newCallId, postJson, postLines, trimSlash } from "./util";
import type { AISettings } from "./config";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaChatResponse {
  model?: string;
  message: OllamaMessage;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

const usageOf = (r: OllamaChatResponse): Usage => ({ inputTokens: r.prompt_eval_count ?? 0, outputTokens: r.eval_count ?? 0 });

export class OllamaProvider implements AIProvider {
  readonly label = "Local AI";
  readonly cacheKey: string;
  private readonly base: string;

  constructor(private readonly cfg: AISettings["ollama"]) {
    this.base = trimSlash(cfg.baseUrl);
    this.cacheKey = `ollama:${cfg.visionModel}+${cfg.textModel}`;
  }

  private async insight(model: string, user: OllamaMessage, ctx: AnalyzeContext): Promise<InsightResult> {
    const res = await postJson<OllamaChatResponse>(`${this.base}/api/chat`, {
      model,
      messages: [{ role: "system", content: insightSystemPrompt(ctx) }, user],
      stream: false,
      format: "json",
      options: { temperature: 0.2 },
    });
    return { insight: parseInsight(res.message.content), usage: usageOf(res), model };
  }

  async describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext) {
    return this.insight(this.cfg.visionModel, { role: "user", content: describeMeta(meta), images: [await blobToBase64(thumb)] }, ctx);
  }

  async describeText(text: string, meta: FileMeta, ctx: AnalyzeContext) {
    return this.insight(this.cfg.textModel, { role: "user", content: `${describeMeta(meta)}\n\nExtracted text:\n${text || "(none)"}` }, ctx);
  }

  async *chat(system: string, messages: ChatMessage[], tools: ToolDef[], opts: ChatOpts = {}): AsyncGenerator<ChatEvent> {
    const wire: OllamaMessage[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") wire.push({ role: "user", content: m.content });
      else if (m.role === "assistant")
        wire.push({ role: "assistant", content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) } : {}) });
      else wire.push({ role: "tool", content: m.content, tool_name: m.name });
    }
    const body = {
      model: this.cfg.textModel,
      messages: wire,
      stream: true,
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    };
    let content = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: ToolCall[] = [];
    for await (const line of postLines(`${this.base}/api/chat`, body, {}, opts.signal)) {
      const chunk = JSON.parse(line) as OllamaChatResponse;
      if (chunk.message?.content) {
        content += chunk.message.content;
        yield { type: "text", text: chunk.message.content };
      }
      for (const c of chunk.message?.tool_calls ?? []) toolCalls.push({ id: newCallId(), name: c.function.name, input: c.function.arguments ?? {} });
      if (chunk.done) usage = usageOf(chunk);
    }
    yield { type: "done", content, toolCalls, usage, model: this.cfg.textModel };
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
      const loc = (globalThis as { location?: { origin: string } }).location;
      const origin = loc ? loc.origin : "this server";
      throw new Error(`Can't reach Ollama at ${this.base}. Start Ollama and set OLLAMA_ORIGINS to allow ${origin}.`);
    }
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const { models } = (await res.json()) as { models: { name: string }[] };
    const names = models.map((m) => m.name);
    const missing = [this.cfg.visionModel, this.cfg.textModel].filter((m) => !names.some((n) => n === m || n.startsWith(`${m}:`)));
    if (missing.length) throw new Error(`Connected, but these models aren't pulled yet: ${missing.join(", ")} (run: ollama pull ${missing[0]})`);
    return `Connected · ${names.length} models available`;
  }
}
