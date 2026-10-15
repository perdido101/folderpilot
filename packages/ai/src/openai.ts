import { EMBEDDING_DIMS } from "@folderpilot/core";
import { describeMeta, insightSystemPrompt } from "./prompts";
import { parseInsight } from "./parse";
import type { AIProvider, AnalyzeContext, ChatEvent, ChatMessage, ChatOpts, FileMeta, InsightResult, ToolCall, ToolDef, Usage } from "./types";
import { blobToBase64, parseArgs, postJson, postLines, sseData, trimSlash } from "./util";
import type { AISettings } from "./config";

type Content = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: Content | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface CompletionResponse {
  model?: string;
  choices: { message: { content: string | null } }[];
  usage?: WireUsage;
}

interface StreamChunk {
  model?: string;
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: WireUsage | null;
}

const usageOf = (u: WireUsage | null | undefined): Usage => ({ inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0 });

/** Any OpenAI-compatible endpoint: OpenAI, Azure OpenAI, gateways, LM Studio, vLLM… */
export class OpenAICompatibleProvider implements AIProvider {
  readonly label: string;
  readonly cacheKey: string;
  private readonly base: string;

  constructor(private readonly cfg: AISettings["openai"]) {
    this.base = trimSlash(cfg.baseUrl);
    this.label = `Your cloud: ${cfg.name || "OpenAI-compatible"}`;
    this.cacheKey = `openai:${cfg.model}`;
  }

  private headers(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}`, "api-key": this.cfg.apiKey } : {};
  }

  private async insight(user: WireMessage, ctx: AnalyzeContext): Promise<InsightResult> {
    const res = await postJson<CompletionResponse>(
      `${this.base}/chat/completions`,
      { model: this.cfg.model, messages: [{ role: "system", content: insightSystemPrompt(ctx) }, user], response_format: { type: "json_object" } },
      this.headers(),
    );
    const choice = res.choices[0];
    if (!choice) throw new Error("Empty response from AI endpoint");
    return { insight: parseInsight(choice.message.content ?? ""), usage: usageOf(res.usage), model: res.model ?? this.cfg.model };
  }

  async describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext) {
    const url = `data:${thumb.type || "image/jpeg"};base64,${await blobToBase64(thumb)}`;
    return this.insight({ role: "user", content: [{ type: "text", text: describeMeta(meta) }, { type: "image_url", image_url: { url } }] }, ctx);
  }

  async describeText(text: string, meta: FileMeta, ctx: AnalyzeContext) {
    return this.insight({ role: "user", content: `${describeMeta(meta)}\n\nExtracted text:\n${text || "(none)"}` }, ctx);
  }

  async *chat(system: string, messages: ChatMessage[], tools: ToolDef[], opts: ChatOpts = {}): AsyncGenerator<ChatEvent> {
    const wire: WireMessage[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") wire.push({ role: "user", content: m.content });
      else if (m.role === "assistant")
        wire.push({
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        });
      else wire.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
    const body = {
      model: this.cfg.model,
      messages: wire,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    };
    let content = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let model = this.cfg.model;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of sseData(postLines(`${this.base}/chat/completions`, body, this.headers(), opts.signal))) {
      const chunk = JSON.parse(data) as StreamChunk;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = usageOf(chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        yield { type: "text", text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    const toolCalls: ToolCall[] = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ id: c.id, name: c.name, input: parseArgs(c.args) }));
    yield { type: "done", content, toolCalls, usage, model };
  }

  /** Ask for 1024 dimensions (what FolderPilot stores); servers that don't support `dimensions` are asked again without it. */
  private sendDimensions = true;

  async embed(texts: string[]) {
    const request = (withDims: boolean) =>
      postJson<{ data: { embedding: number[]; index: number }[] }>(`${this.base}/embeddings`, { model: this.cfg.embedModel, input: texts, ...(withDims ? { dimensions: EMBEDDING_DIMS } : {}) }, this.headers());
    let res;
    try {
      res = await request(this.sendDimensions);
    } catch (err) {
      if (!this.sendDimensions || !/^4\d\d /.test(err instanceof Error ? err.message : "")) throw err;
      this.sendDimensions = false;
      res = await request(false);
    }
    return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async test() {
    const res = await postJson<CompletionResponse>(`${this.base}/chat/completions`, { model: this.cfg.model, messages: [{ role: "user", content: "Reply with the single word OK." }] }, this.headers());
    return `Connected · ${this.cfg.model} replied “${(res.choices[0]?.message.content ?? "").trim().slice(0, 20)}”`;
  }
}
