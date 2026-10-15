/**
 * AI routes for an organization:
 * - settings (admin): provider, keys (stored encrypted, never returned), thresholds, monthly file budget, usage;
 * - FolderPilot AI for folders on "This device": describe (thumbnail ≤512px or text) and streaming chat.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { AI_SECRET_FIELDS, withDefaults, type AIProvider, type AISettings, type ChatEvent, type ChatMessage, type ToolDef } from "@folderpilot/ai";
import { BudgetExceededError, describeMetered, loadOrgSettings, recordUsage, saveOrgSettings, toPublic, usageThisMonth } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireOrg, requirePermission } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

const str = (max = 500) => z.string().max(max);

const SettingsBody = z.object({
  ai: z.object({
    provider: z.enum(["none", "folderpilot", "ollama", "openai", "anthropic"]),
    ollama: z.object({ baseUrl: str(), visionModel: str(120), textModel: str(120), embedModel: str(120) }).partial().optional(),
    openai: z.object({ name: str(80), baseUrl: str(), apiKey: str(500), model: str(120), embedModel: str(120) }).partial().optional(),
    anthropic: z
      .object({
        name: str(80),
        platform: z.enum(["anthropic", "bedrock", "vertex"]),
        baseUrl: str(),
        apiKey: str(500),
        model: str(120),
        bedrock: z.object({ region: str(40), accessKeyId: str(200), secretAccessKey: str(500) }).partial(),
        vertex: z.object({ projectId: str(120), region: str(40), serviceAccountJson: str(20_000) }).partial(),
      })
      .partial()
      .optional(),
  }),
  thresholds: z.object({
    nearDuplicateDistance: z.number().int().min(0).max(20),
    blur: z.number().min(0).max(1000),
    dark: z.number().min(0).max(255),
    tiny: z.number().int().min(0).max(10_000),
    confidence: z.number().min(0).max(1),
  }),
  aiMonthlyFileBudget: z.number().int().min(0).max(1_000_000),
  /** Small agent/MCP plans that may run without approval (0 = never). */
  autoRun: z.object({ maxFiles: z.number().int().min(0).max(1000), allowMcp: z.boolean() }).optional(),
  clearSecrets: z.array(z.enum(AI_SECRET_FIELDS)).default([]),
});

const MetaBody = z.object({
  name: str(400),
  path: str(2000),
  ext: str(20),
  size: z.number().nonnegative(),
  mtime: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  exif: z.record(z.union([z.string().max(200), z.number()])).optional(),
  flags: z.array(str(40)).max(20),
  sha256: z.string().max(80).optional(),
});
const CtxBody = z.object({ knownCategories: z.array(str(60)).max(80), naturalRules: z.array(str(2000)).max(50) });

/** A 512px JPEG is ~50–150 KB; anything far bigger isn't a thumbnail. */
const MAX_THUMB_BASE64 = 700_000;
const DescribeBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), image: z.string().max(MAX_THUMB_BASE64, "Thumbnails must be at most 512px."), mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]), meta: MetaBody, ctx: CtxBody }),
  z.object({ kind: z.literal("text"), text: z.string().max(20_000), meta: MetaBody, ctx: CtxBody }),
]);

const ChatBody = z.object({
  system: z.string().max(50_000),
  messages: z.array(z.record(z.unknown())).max(200),
  tools: z.array(z.object({ name: str(64), description: str(2000), parameters: z.record(z.unknown()) })).max(50),
});

const providerKind = (p: AIProvider) => p.cacheKey.split(":")[0]!;

export function aiRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("/:orgId/*", requireOrg(deps));

  const settingsFor = (orgId: string) => loadOrgSettings(deps.db, orgId, deps.encryptionKey);

  // ── Settings (admins) ──
  app.get("/:orgId/settings/ai", requirePermission("settings", "manage"), async (c) => {
    const orgId = c.get("org").id;
    const settings = await settingsFor(orgId);
    return c.json({ settings: toPublic(settings), usage: await usageThisMonth(deps.db, orgId), folderpilotAvailable: Boolean(deps.env.ANTHROPIC_API_KEY) });
  });

  app.put("/:orgId/settings/ai", requirePermission("settings", "manage"), async (c) => {
    const parsed = SettingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const { clearSecrets, ...body } = parsed.data;
    const orgId = c.get("org").id;
    const saved = await saveOrgSettings(deps.db, orgId, deps.encryptionKey, { ...body, ai: withDefaults(body.ai as Partial<AISettings>) }, clearSecrets);
    deps.log.info({ orgId, provider: saved.ai.provider, by: c.get("user")?.id }, "AI settings changed");
    return c.json({ settings: toPublic(saved) });
  });

  app.post("/:orgId/settings/ai/test", requirePermission("settings", "manage"), async (c) => {
    const provider = deps.ai.forOrg((await settingsFor(c.get("org").id)).ai);
    if (!provider) return c.json({ ok: false, message: "No AI is configured (or a required field is empty)." });
    try {
      return c.json({ ok: true, message: await provider.test() });
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** For the AI status pill: which AI this organization uses (no secrets). */
  app.get("/:orgId/ai/status", async (c) => {
    const settings = await settingsFor(c.get("org").id);
    const provider = deps.ai.forOrg(settings.ai);
    return c.json({ provider: settings.ai.provider, label: provider?.label ?? null, folderpilotAvailable: Boolean(deps.env.ANTHROPIC_API_KEY) });
  });

  // ── FolderPilot AI for folders on this device ──
  const hostedOr503 = () => {
    const p = deps.ai.hosted();
    if (!p) throw new HTTPException(503, { message: "FolderPilot AI isn't configured on this server (ANTHROPIC_API_KEY). See docs/SETUP.md." });
    return p;
  };

  app.post("/:orgId/ai/describe", requirePermission("file", "organize"), rateLimit(deps.redis, { prefix: "ai-describe", windowSec: 60, max: 120 }), async (c) => {
    const parsed = DescribeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const provider = hostedOr503();
    const orgId = c.get("org").id;
    const body = parsed.data;
    const settings = await settingsFor(orgId);
    try {
      const input =
        body.kind === "image"
          ? { kind: "image" as const, image: new Blob([Buffer.from(body.image, "base64")], { type: body.mediaType }), meta: body.meta, ctx: body.ctx }
          : { kind: "text" as const, text: body.text, meta: body.meta, ctx: body.ctx };
      return c.json(await describeMetered(deps.db, orgId, provider, input, settings.aiMonthlyFileBudget));
    } catch (err) {
      if (err instanceof BudgetExceededError) throw new HTTPException(429, { message: err.message });
      deps.log.warn({ orgId, err: err instanceof Error ? err.message : String(err) }, "FolderPilot AI describe failed");
      throw new HTTPException(502, { message: err instanceof Error ? err.message : "The AI request failed." });
    }
  });

  app.post("/:orgId/ai/chat", requirePermission("file", "view"), rateLimit(deps.redis, { prefix: "ai-chat", windowSec: 60, max: 30 }), async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const provider = hostedOr503();
    const orgId = c.get("org").id;
    const { system, messages, tools } = parsed.data;
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of provider.chat(system, messages as unknown as ChatMessage[], tools as ToolDef[], { signal: c.req.raw.signal })) {
          await stream.writeSSE({ data: JSON.stringify(event satisfies ChatEvent) });
          if (event.type === "done") await recordUsage(deps.db, orgId, { provider: providerKind(provider), model: event.model, purpose: "agent", usage: event.usage, files: 0 });
        }
      } catch (err) {
        await stream.writeSSE({ data: JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "The AI request failed." }) });
      }
    });
  });

  return app;
}
