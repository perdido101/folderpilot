/**
 * The agent for server spaces (spec §9): a streaming chat whose tools run here, against Postgres, scoped to the
 * organization, the space and the person's role. Every change is a plan (pending unless the admin allows small agent
 * plans to auto-run). Every tool call is logged in agent_tool_calls.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { agentSystemPrompt, runAgent, summarizeToolInput, type AgentEvent, type ChatMessage } from "@folderpilot/ai";
import { can } from "@folderpilot/core";
import { agentToolCalls, createSpaceTools, loadOrgSettings, recordUsage, scoped, spaces } from "@folderpilot/db";
import type { AppEnv, Deps } from "../context";
import { requireOrg, requirePermission } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

const ToolCallSchema = z.object({ id: z.string().max(200), name: z.string().max(64), input: z.record(z.unknown()) });
const MessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string().max(8000) }),
  z.object({ role: z.literal("assistant"), content: z.string().max(20_000), toolCalls: z.array(ToolCallSchema).max(20).optional(), raw: z.unknown().optional() }),
  z.object({ role: z.literal("tool"), toolCallId: z.string().max(200), name: z.string().max(64), content: z.string().max(20_000), isError: z.boolean().optional() }),
]);
const AgentBody = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z.array(MessageSchema).max(200).default([]),
  conversationId: z.string().max(100).optional(),
});

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;
const providerKind = (cacheKey: string) => cacheKey.split(":")[0]!;

export function agentRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("/:orgId/*", requireOrg(deps));

  app.post("/:orgId/spaces/:spaceId/agent", requirePermission("file", "view"), rateLimit(deps.redis, { prefix: "agent", windowSec: 60, max: 30 }), async (c) => {
    const org = c.get("org");
    const user = c.get("user")!;
    const spaceId = c.req.param("spaceId");
    const space = isUuid(spaceId) ? await scoped(deps.db, org.id).first(spaces, eq(spaces.id, spaceId)) : undefined;
    if (!space) throw new HTTPException(404, { message: "Space not found." });
    const parsed = AgentBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const settings = await loadOrgSettings(deps.db, org.id, deps.encryptionKey);
    const provider = deps.ai.forOrg(settings.ai);
    if (!provider) throw new HTTPException(409, { message: "No AI is connected for this organization. An admin can connect one in Settings → AI." });

    const { message, history, conversationId } = parsed.data;
    const tools = createSpaceTools({
      db: deps.db,
      orgId: org.id,
      userId: user.id,
      role: org.role,
      space,
      adapter: () => deps.adapterFor(space),
      autoRun: settings.autoRun,
      thresholds: settings.thresholds,
    });
    const system = agentSystemPrompt({ spaceName: space.name, today: new Date().toISOString().slice(0, 10), canApprove: can(org.role, "plan", "approve"), where: "server" });
    const signal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
      const events = runAgent({
        provider,
        system,
        tools,
        history: history as ChatMessage[],
        userText: message,
        signal,
        onToolCall: async (call) => {
          await scoped(deps.db, org.id)
            .insert(agentToolCalls, {
              userId: user.id,
              spaceId: space.id,
              via: "agent",
              conversationId: conversationId ?? null,
              tool: call.name,
              input: summarizeToolInput(call.input ?? {}),
              ok: call.ok,
              error: call.error?.slice(0, 500) ?? null,
              durationMs: Math.round(call.ms),
            })
            .catch((err: unknown) => deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, "agent tool call not logged"));
        },
      });
      for await (const ev of events) {
        if (ev.type === "done") await recordUsage(deps.db, org.id, { provider: providerKind(provider.cacheKey), model: ev.model || "unknown", purpose: "agent", usage: ev.usage, files: 0 });
        await stream.writeSSE({ data: JSON.stringify(ev satisfies AgentEvent) });
      }
    });
  });

  /** What the agent did with its tools. Admins see everyone's calls; others see their own. */
  app.get("/:orgId/agent/activity", requirePermission("audit", "view"), async (c) => {
    const org = c.get("org");
    const user = c.get("user")!;
    const spaceId = c.req.query("spaceId");
    const limit = Math.min(500, Number(c.req.query("limit") ?? 200) || 200);
    const conds: SQL[] = [];
    if (!can(org.role, "settings", "manage")) conds.push(eq(agentToolCalls.userId, user.id));
    if (spaceId && isUuid(spaceId)) conds.push(eq(agentToolCalls.spaceId, spaceId));
    const rows = await deps.db
      .select()
      .from(agentToolCalls)
      .where(scoped(deps.db, org.id).where(agentToolCalls, conds.length ? (and(...conds) as SQL) : undefined))
      .orderBy(desc(agentToolCalls.at))
      .limit(limit);
    return c.json({
      calls: rows.map((r) => ({ id: r.id, at: r.at.getTime(), userId: r.userId, spaceId: r.spaceId, via: r.via, tool: r.tool, input: r.input, ok: r.ok, error: r.error, durationMs: r.durationMs })),
    });
  });

  return app;
}
