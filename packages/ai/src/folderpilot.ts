/**
 * FolderPilot AI from the browser: our hosted Claude, reached through the FolderPilot API (the key never leaves the server).
 * Only ≤512px thumbnails or extracted text are sent; the server meters them against the organization's monthly AI budget.
 */
import { blobToBase64, postJson, postLines, sseData, trimSlash } from "./util";
import { AIError, type AIProvider, type AnalyzeContext, type ChatEvent, type ChatMessage, type ChatOpts, type FileMeta, type InsightResult, type ToolDef } from "./types";

export interface FolderPilotProviderOptions {
  /** API origin ("" for same-origin). */
  apiBase: string;
  orgId: string;
}

export class FolderPilotProvider implements AIProvider {
  readonly label = "FolderPilot AI";
  readonly cacheKey = "folderpilot";
  private readonly base: string;

  constructor(opts: FolderPilotProviderOptions) {
    this.base = `${trimSlash(opts.apiBase)}/api/orgs/${encodeURIComponent(opts.orgId)}/ai`;
  }

  private post<T>(path: string, body: unknown) {
    return postJson<T>(`${this.base}/${path}`, body, { "x-requested-with": "folderpilot" });
  }

  async describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext) {
    return this.post<InsightResult>("describe", { kind: "image", image: await blobToBase64(thumb), mediaType: thumb.type || "image/jpeg", meta, ctx });
  }

  async describeText(text: string, meta: FileMeta, ctx: AnalyzeContext) {
    return this.post<InsightResult>("describe", { kind: "text", text, meta, ctx });
  }

  async *chat(system: string, messages: ChatMessage[], tools: ToolDef[], opts: ChatOpts = {}): AsyncGenerator<ChatEvent> {
    for await (const data of sseData(postLines(`${this.base}/chat`, { system, messages, tools }, { "x-requested-with": "folderpilot" }, opts.signal))) {
      const event = JSON.parse(data) as ChatEvent | { type: "error"; message: string };
      if (event.type === "error") throw new AIError(event.message);
      yield event;
    }
  }

  async test() {
    return (await this.post<{ message: string }>("test", {})).message;
  }
}
