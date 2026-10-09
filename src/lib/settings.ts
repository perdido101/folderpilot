import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";

export type ProviderKind = "none" | "ollama" | "openai" | "anthropic";

export interface AISettings {
  provider: ProviderKind;
  ollama: { baseUrl: string; visionModel: string; textModel: string; embedModel: string };
  openai: { name: string; baseUrl: string; apiKey: string; model: string; embedModel: string };
  anthropic: { name: string; baseUrl: string; apiKey: string; model: string };
}

export interface Thresholds {
  /** Max Hamming distance between dHashes to count as near-duplicates. */
  nearDuplicateDistance: number;
  /** Laplacian variance below this = blurry. */
  blur: number;
  /** Mean luminance (0–255) below this = dark. */
  dark: number;
  /** Longest side below this (px) = tiny. */
  tiny: number;
  /** AI confidence below this goes to Needs Review. */
  confidence: number;
}

export interface AppSettings {
  ai: AISettings;
  thresholds: Thresholds;
  autoAnalyzeWithAI: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    provider: "none",
    ollama: { baseUrl: "http://localhost:11434", visionModel: "llava:7b", textModel: "llama3.2:3b", embedModel: "nomic-embed-text" },
    openai: { name: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini", embedModel: "text-embedding-3-small" },
    anthropic: { name: "Claude", baseUrl: "https://api.anthropic.com", apiKey: "", model: "claude-opus-5-5" },
  },
  thresholds: { nearDuplicateDistance: 6, blur: 60, dark: 45, tiny: 300, confidence: 0.6 },
  autoAnalyzeWithAI: false,
};

const KEY = "app";

function merge(stored: Partial<AppSettings> | undefined): AppSettings {
  const s = stored ?? {};
  return {
    ai: {
      ...DEFAULT_SETTINGS.ai,
      ...s.ai,
      ollama: { ...DEFAULT_SETTINGS.ai.ollama, ...s.ai?.ollama },
      openai: { ...DEFAULT_SETTINGS.ai.openai, ...s.ai?.openai },
      anthropic: { ...DEFAULT_SETTINGS.ai.anthropic, ...s.ai?.anthropic },
    },
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...s.thresholds },
    autoAnalyzeWithAI: s.autoAnalyzeWithAI ?? DEFAULT_SETTINGS.autoAnalyzeWithAI,
  };
}

export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get(KEY);
  return merge(row?.value as Partial<AppSettings> | undefined);
}

export async function saveSettings(update: (s: AppSettings) => AppSettings): Promise<void> {
  const next = update(await getSettings());
  await db.settings.put({ key: KEY, value: next });
}

export function useSettings(): AppSettings {
  const row = useLiveQuery(() => db.settings.get(KEY), []);
  return merge(row?.value as Partial<AppSettings> | undefined);
}
