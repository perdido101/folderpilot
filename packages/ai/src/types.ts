import { z } from "zod";

const nullableText = (max: number) => z.string().max(max).nullable();

/** Facts the AI found in the file (used by rules variables like {client} and {docType}). */
export const EntitiesSchema = z.object({
  client: nullableText(80),
  date: nullableText(40),
  amount: nullableText(40),
  docType: nullableText(60),
});
export type Entities = z.infer<typeof EntitiesSchema>;

/** What the AI returns about one file. Validated with zod; anything else is rejected. */
export const FileInsightSchema = z.object({
  category: z.string().min(1).max(60),
  tags: z.array(z.string().min(1).max(40)).max(8),
  caption: z.string().max(300),
  suggestedName: z.string().max(120),
  entities: EntitiesSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});
export type FileInsight = z.infer<typeof FileInsightSchema>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** An insight plus what it cost and which model produced it (for metering and the cache). */
export interface InsightResult {
  insight: FileInsight;
  usage: Usage;
  model: string;
}

export interface FileMeta {
  name: string;
  path: string;
  ext: string;
  size: number;
  mtime: number;
  width?: number;
  height?: number;
  exif?: Record<string, string | number>;
  flags: string[];
  /** Content hash, so a server can reuse an earlier insight for identical content. */
  sha256?: string;
}

export interface AnalyzeContext {
  /** Categories already in use, so the AI reuses them instead of inventing synonyms. */
  knownCategories: string[];
  /** Natural-language rules written by the user, injected verbatim. */
  naturalRules: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: string }
  /** `raw` keeps the provider's native assistant content so it can be replayed unchanged. */
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  usage: Usage;
  model: string;
}

/** Streaming chat: text as it is written, then the complete turn. */
export type ChatEvent = { type: "text"; text: string } | ({ type: "done" } & ChatResult);

export interface ChatOpts {
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly label: string;
  /** Short id of the provider + model, used as the insight cache key. */
  readonly cacheKey: string;
  describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext): Promise<InsightResult>;
  describeText(text: string, meta: FileMeta, ctx: AnalyzeContext): Promise<InsightResult>;
  chat(system: string, messages: ChatMessage[], tools: ToolDef[], opts?: ChatOpts): AsyncIterable<ChatEvent>;
  /** Present when the provider has an embedding model (Ollama, OpenAI-compatible). */
  embed?(texts: string[]): Promise<number[][]>;
  /** Cheap request that proves the endpoint, key and model work. */
  test(): Promise<string>;
}

export class AIError extends Error {}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** Run a streaming chat to the end (for callers that don't render text as it arrives). */
export async function collectChat(events: AsyncIterable<ChatEvent>): Promise<ChatResult> {
  for await (const e of events) if (e.type === "done") return e;
  throw new AIError("The AI stream ended without a result.");
}
