import { z } from "zod";

/** What the AI returns about one file. Validated with zod; anything else is rejected. */
export const FileInsightSchema = z.object({
  category: z.string().min(1).max(60),
  tags: z.array(z.string().min(1).max(40)).max(8),
  caption: z.string().max(300),
  suggestedName: z.string().max(120),
  client: z.string().max(80).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});
export type FileInsight = z.infer<typeof FileInsightSchema>;

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
}

export interface AIProvider {
  readonly label: string;
  describeImage(thumb: Blob, meta: FileMeta, ctx: AnalyzeContext): Promise<FileInsight>;
  describeText(text: string, meta: FileMeta, ctx: AnalyzeContext): Promise<FileInsight>;
  chat(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult>;
  embed?(texts: string[]): Promise<number[][]>;
  /** Cheap request that proves the endpoint, key and model work. */
  test(): Promise<string>;
}

export class AIError extends Error {}
