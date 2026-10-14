import { describe, expect, it } from "vitest";
import { DEFAULT_AI_SETTINGS } from "./config";
import { bedrockModelId, createServerProvider } from "./server";

const hosted = { apiKey: "sk-ant-ours", analysisModel: "claude-haiku-5-5", agentModel: "claude-opus-5-5" };

describe("createServerProvider", () => {
  it("builds FolderPilot AI only when our key is configured", () => {
    const settings = { ...DEFAULT_AI_SETTINGS, provider: "folderpilot" as const };
    expect(createServerProvider(settings, hosted)).toMatchObject({ label: "FolderPilot AI", cacheKey: "folderpilot:claude-haiku-5-5" });
    expect(createServerProvider(settings, { ...hosted, apiKey: undefined })).toBeNull();
  });

  it("builds a customer's Claude on Bedrock (prefixed model id) and Vertex", () => {
    const anthropic = DEFAULT_AI_SETTINGS.anthropic;
    const bedrock = createServerProvider({ ...DEFAULT_AI_SETTINGS, provider: "anthropic", anthropic: { ...anthropic, platform: "bedrock", bedrock: { region: "eu-central-1", accessKeyId: "AKIA", secretAccessKey: "s" } } }, hosted);
    expect(bedrock?.cacheKey).toBe("bedrock:anthropic.claude-opus-5-5");
    const vertex = createServerProvider({ ...DEFAULT_AI_SETTINGS, provider: "anthropic", anthropic: { ...anthropic, platform: "vertex", vertex: { projectId: "p", region: "global", serviceAccountJson: "" } } }, hosted);
    expect(vertex?.cacheKey).toBe("vertex:claude-opus-5-5");
    expect(createServerProvider({ ...DEFAULT_AI_SETTINGS, provider: "anthropic", anthropic: { ...anthropic, platform: "vertex" } }, hosted)).toBeNull();
    expect(bedrockModelId("anthropic.claude-opus-5-5")).toBe("anthropic.claude-opus-5-5");
  });

  it("returns null when nothing is configured", () => {
    expect(createServerProvider(DEFAULT_AI_SETTINGS, hosted)).toBeNull();
    expect(createServerProvider({ ...DEFAULT_AI_SETTINGS, provider: "anthropic" }, hosted)).toBeNull();
  });
});
