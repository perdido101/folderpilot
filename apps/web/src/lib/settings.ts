import { useLiveQuery } from "dexie-react-hooks";
import { DEFAULT_AI_SETTINGS, withDefaults, type AISettings } from "@folderpilot/ai";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@folderpilot/core";
import { db } from "./db";

export type { AISettings, ProviderKind } from "@folderpilot/ai";
export type { Thresholds } from "@folderpilot/core";

export interface AppSettings {
  ai: AISettings;
  thresholds: Thresholds;
  autoAnalyzeWithAI: boolean;
  /** Agent plans touching at most this many files run without approval (0 = always ask). Never trash or rules. */
  agentAutoRunMaxFiles: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  ai: DEFAULT_AI_SETTINGS,
  thresholds: DEFAULT_THRESHOLDS,
  autoAnalyzeWithAI: false,
  agentAutoRunMaxFiles: 0,
};

const KEY = "app";

function merge(stored: Partial<AppSettings> | undefined): AppSettings {
  const s = stored ?? {};
  return {
    ai: withDefaults(s.ai),
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...s.thresholds },
    autoAnalyzeWithAI: s.autoAnalyzeWithAI ?? DEFAULT_SETTINGS.autoAnalyzeWithAI,
    agentAutoRunMaxFiles: s.agentAutoRunMaxFiles ?? DEFAULT_SETTINGS.agentAutoRunMaxFiles,
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
