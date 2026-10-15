/** Every provider against a local mock HTTP server: insights, streaming chat with a tool call, embeddings, usage, errors. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnthropicProvider, FolderPilotProvider, OllamaProvider, OpenAICompatibleProvider, collectChat, DEFAULT_AI_SETTINGS, createProvider, type ChatEvent } from "./index";

type Handler = (body: Record<string, unknown>, res: http.ServerResponse) => void;
const routes = new Map<string, Handler>();
const received: { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }[] = [];
let server: http.Server;
let base = "";

const insightJson = {
  category: "Invoices",
  tags: ["invoice"],
  caption: "Invoice 1001 from Alpha Ltd.",
  suggestedName: "2024-03 Invoice 1001 - Alpha Ltd",
  entities: { client: "Alpha Ltd", date: "2024-03", amount: "EUR 1,250.00", docType: "invoice" },
  confidence: 0.91,
  reason: "Says INVOICE",
};
const meta = { name: "scan.pdf", path: "Inbox/scan.pdf", ext: "pdf", size: 1000, mtime: 0, flags: [] };
const ctx = { knownCategories: ["Invoices"], naturalRules: ["Screenshots go to Temp"] };
const tools = [{ name: "list_files", description: "List files", parameters: { type: "object", properties: { folder: { type: "string" } } } }];

const json = (res: http.ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const sse = (res: http.ServerResponse, events: unknown[], named = false) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`${named ? `event: ${(e as { type: string }).type}\n` : ""}data: ${JSON.stringify(e)}\n\n`);
  res.end();
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const path = (req.url ?? "").split("?")[0]!;
      received.push({ path, body, headers: req.headers });
      const handler = routes.get(path);
      if (handler) handler(body, res);
      else json(res, { error: "not found" }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  routes.clear();
  received.length = 0;
});

async function events(it: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("Ollama", () => {
  const ollama = () => new OllamaProvider({ ...DEFAULT_AI_SETTINGS.ollama, baseUrl: base });

  it("describes text with JSON mode and reports usage", async () => {
    routes.set("/api/chat", (_b, res) => json(res, { model: "llama3.2:3b", message: { role: "assistant", content: JSON.stringify(insightJson) }, done: true, prompt_eval_count: 120, eval_count: 40 }));
    const r = await ollama().describeText("INVOICE 1001", meta, ctx);
    expect(r.insight.entities.client).toBe("Alpha Ltd");
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(received[0]!.body).toMatchObject({ model: "llama3.2:3b", format: "json", stream: false });
    expect(JSON.stringify(received[0]!.body.messages)).toContain("Screenshots go to Temp");
  });

  it("streams chat text and tool calls", async () => {
    routes.set("/api/chat", (_b, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { role: "assistant", content: "Look" } }) + "\n");
      res.write(JSON.stringify({ message: { role: "assistant", content: "ing…", tool_calls: [{ function: { name: "list_files", arguments: { folder: "Inbox" } } }] } }) + "\n");
      res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 50, eval_count: 9 }) + "\n");
    });
    const out = await events(ollama().chat("system", [{ role: "user", content: "what's in Inbox?" }], tools));
    expect(out.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Looking…");
    const done = out.at(-1)!;
    expect(done).toMatchObject({ type: "done", content: "Looking…", toolCalls: [{ name: "list_files", input: { folder: "Inbox" } }], usage: { inputTokens: 50, outputTokens: 9 } });
  });

  it("embeds", async () => {
    routes.set("/api/embed", (_b, res) => json(res, { embeddings: [[0.1, 0.2]] }));
    expect(await ollama().embed(["x"])).toEqual([[0.1, 0.2]]);
  });
});

describe("OpenAI-compatible", () => {
  const openai = () => new OpenAICompatibleProvider({ ...DEFAULT_AI_SETTINGS.openai, baseUrl: base, apiKey: "sk-test" });

  it("describes an image with a data URL and the key header", async () => {
    routes.set("/chat/completions", (_b, res) => json(res, { model: "gpt-4o-mini", choices: [{ message: { content: "```json\n" + JSON.stringify(insightJson) + "\n```" } }], usage: { prompt_tokens: 300, completion_tokens: 60 } }));
    const r = await openai().describeImage(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), meta, ctx);
    expect(r).toMatchObject({ insight: { category: "Invoices" }, usage: { inputTokens: 300, outputTokens: 60 }, model: "gpt-4o-mini" });
    expect(received[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.stringify(received[0]!.body)).toContain("data:image/jpeg;base64,AQID");
  });

  it("assembles streamed tool-call fragments and usage", async () => {
    routes.set("/chat/completions", (_b, res) =>
      sse(res, [
        { model: "gpt-4o-mini", choices: [{ delta: { content: "Sure" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_", arguments: '{"fol' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "files", arguments: 'der":"Inbox"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]),
    );
    const done = await collectChat(openai().chat("s", [{ role: "user", content: "hi" }], tools));
    expect(done).toMatchObject({ content: "Sure", toolCalls: [{ id: "call_1", name: "list_files", input: { folder: "Inbox" } }], usage: { inputTokens: 10, outputTokens: 5 } });
    expect(received[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("turns HTTP errors into readable messages and rejects invalid JSON insights", async () => {
    routes.set("/chat/completions", (_b, res) => json(res, { error: { message: "bad key" } }, 401));
    await expect(openai().describeText("x", meta, ctx)).rejects.toThrow(/401.*bad key/);
    routes.set("/chat/completions", (_b, res) => json(res, { choices: [{ message: { content: '{"category": "", "confidence": 2}' } }] }));
    await expect(openai().describeText("x", meta, ctx)).rejects.toThrow();
  });
});

describe("Claude (Anthropic SDK)", () => {
  const claude = () => AnthropicProvider.direct({ ...DEFAULT_AI_SETTINGS.anthropic, baseUrl: base, apiKey: "sk-ant-test", model: "claude-opus-5-5" });
  const message = (content: unknown[], stop_reason = "end_turn") => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 50 },
  });

  it("returns a structured insight with usage; no fallbacks for a non-Anthropic host", async () => {
    routes.set("/v1/messages", (_b, res) => json(res, message([{ type: "text", text: JSON.stringify(insightJson) }])));
    const r = await claude().describeText("INVOICE", meta, ctx);
    expect(r).toMatchObject({ insight: { entities: { amount: "EUR 1,250.00" } }, usage: { inputTokens: 200, outputTokens: 50 }, model: "claude-opus-5-5" });
    const body = received[0]!.body;
    expect(body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(body).not.toHaveProperty("fallbacks");
  });

  it("reports refusals instead of guessing", async () => {
    routes.set("/v1/messages", (_b, res) => json(res, message([], "refusal")));
    await expect(claude().describeText("x", meta, ctx)).rejects.toThrow(/declined/);
  });

  it("streams text and returns tool calls with the raw blocks for replay", async () => {
    routes.set("/v1/messages", (_b, res) =>
      sse(
        res,
        [
          { type: "message_start", message: { ...message([]), usage: { input_tokens: 80, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking " } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Inbox." } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "list_files", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"folder":"Inbox"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } },
          { type: "message_stop" },
        ],
        true,
      ),
    );
    const out = await events(claude().chat("system", [{ role: "user", content: "what's in Inbox?" }], tools));
    expect(out.filter((e) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual(["Checking ", "Inbox."]);
    const done = out.at(-1)!;
    expect(done).toMatchObject({ type: "done", content: "Checking Inbox.", toolCalls: [{ id: "toolu_1", name: "list_files", input: { folder: "Inbox" } }] });
    expect((done as { raw: unknown[] }).raw).toHaveLength(2);
    expect(received[0]!.body).toMatchObject({ stream: true, tools: [{ name: "list_files" }] });
  });
});

describe("FolderPilot AI (through our API)", () => {
  it("posts thumbnails/text to the org's describe endpoint and streams chat over SSE", async () => {
    routes.set("/api/orgs/org_1/ai/describe", (b, res) => json(res, { insight: { ...insightJson, caption: `kind=${String(b.kind)}` }, usage: { inputTokens: 1, outputTokens: 2 }, model: "claude-haiku-5-5" }));
    routes.set("/api/orgs/org_1/ai/chat", (_b, res) =>
      sse(res, [
        { type: "text", text: "Hi" },
        { type: "done", content: "Hi", toolCalls: [], usage: { inputTokens: 3, outputTokens: 1 }, model: "claude-opus-5-5" },
      ]),
    );
    const fp = new FolderPilotProvider({ apiBase: base, orgId: "org_1" });
    const r = await fp.describeImage(new Blob([new Uint8Array([9])], { type: "image/jpeg" }), { ...meta, sha256: "abc" }, ctx);
    expect(r.insight.caption).toBe("kind=image");
    expect(received[0]!.body).toMatchObject({ kind: "image", mediaType: "image/jpeg", meta: { sha256: "abc" } });
    expect((await collectChat(fp.chat("s", [{ role: "user", content: "hi" }], []))).content).toBe("Hi");
  });

  it("surfaces server-side stream errors", async () => {
    routes.set("/api/orgs/org_1/ai/chat", (_b, res) => sse(res, [{ type: "error", message: "Monthly AI budget reached" }]));
    await expect(collectChat(new FolderPilotProvider({ apiBase: base, orgId: "org_1" }).chat("s", [], []))).rejects.toThrow(/budget/);
  });

  it("is only offered in the browser when signed in to an organization", () => {
    const settings = { ...DEFAULT_AI_SETTINGS, provider: "folderpilot" as const };
    expect(createProvider(settings)).toBeNull();
    expect(createProvider(settings, { orgId: "org_1" })?.label).toBe("FolderPilot AI");
    expect(createProvider({ ...DEFAULT_AI_SETTINGS, provider: "anthropic", anthropic: { ...DEFAULT_AI_SETTINGS.anthropic, platform: "bedrock", apiKey: "x" } })).toBeNull();
  });
});

describe("embeddings for search", () => {
  it("asks OpenAI-compatible servers for 1024 dimensions and retries without when unsupported", async () => {
    let calls = 0;
    routes.set("/embeddings", (body, res) => {
      calls++;
      if (body.dimensions !== undefined && calls === 1) return json(res, { error: "dimensions not supported" }, 400);
      json(res, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    });
    const p = new OpenAICompatibleProvider({ ...DEFAULT_AI_SETTINGS.openai, baseUrl: base, apiKey: "k" });
    expect(await p.embed!(["a", "b"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(received.map((r) => r.body.dimensions)).toEqual([1024, undefined]);
    await p.embed!(["c"]);
    expect(received.at(-1)!.body.dimensions).toBeUndefined();
  });

  it("embedderFor: the org's AI when it can embed, else the server's Ollama, else none; vectors are padded to 1024", async () => {
    const { embedderFor } = await import("./server");
    routes.set("/embeddings", (_b, res) => json(res, { data: [{ index: 0, embedding: [0.5, 0.5] }] }));
    routes.set("/api/embed", (_b, res) => json(res, { embeddings: [[0.1, 0.2, 0.3]] }));
    const openai = embedderFor({ ...DEFAULT_AI_SETTINGS, provider: "openai", openai: { ...DEFAULT_AI_SETTINGS.openai, baseUrl: base } });
    expect(openai!.model).toBe("openai:text-embedding-3-small");
    const [v] = await openai!.embed(["x"]);
    expect(v).toHaveLength(1024);
    expect(v!.slice(0, 3)).toEqual([0.5, 0.5, 0]);

    const hosted = embedderFor({ ...DEFAULT_AI_SETTINGS, provider: "folderpilot" }, { ollamaUrl: base, model: "mxbai-embed-large" });
    expect(hosted!.model).toBe("ollama:mxbai-embed-large");
    expect((await hosted!.embed(["x"]))[0]).toHaveLength(1024);
    expect(embedderFor({ ...DEFAULT_AI_SETTINGS, provider: "anthropic" })).toBeNull();
    expect(embedderFor({ ...DEFAULT_AI_SETTINGS, provider: "none" })).toBeNull();
  });
});
