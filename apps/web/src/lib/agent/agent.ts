import { db } from "../db";
import { createProvider } from "@folderpilot/ai";
import type { ChatMessage } from "@folderpilot/ai";
import { keywordSearch } from "../search";
import i18n from "@/i18n";
import { getSettings } from "../settings";
import { runTool, TOOL_DEFS, type ToolContext } from "./tools";

const MAX_STEPS = 8;

export function systemPrompt(folderName: string, today: string): string {
  return [
    "You are FolderPilot, an assistant that helps a small office organize, find and clean files on their own computer.",
    `You work inside the folder “${folderName}”. Only ever act on files in this folder. Today is ${today}.`,
    "Rules you must follow:",
    "- Answer questions directly. Use search_files / list_files / get_overview to look things up; never invent files.",
    "- You cannot delete files and there is no delete tool. If files look useless, use flag_for_deletion; a human decides.",
    "- For ANY change (move, rename, tag, caption, category, rules, undo) call propose_plan / create_rule / update_rule / undo. The user sees a Plan Card and nothing changes until they approve. Never claim a change is done; say it's waiting for approval.",
    "- For 'make a rule' requests, prefer create_rule with structured conditions/actions; folder templates may use {year} {month} {category} {client} {type}.",
    "- Keep answers short. When listing files, show names (and folders when useful), not ids.",
    "- Reply in the same language the user writes in (Greek or English).",
  ].join("\n");
}

export interface AgentTurn {
  messages: ChatMessage[];
  reply: string;
  planIds: number[];
  fileIds: number[];
}

/** One user turn: loop model → tools → model until it answers (max 8 tool rounds). */
export async function runAgentTurn(rootId: number, history: ChatMessage[], userText: string): Promise<AgentTurn> {
  const settings = await getSettings();
  const provider = createProvider(settings.ai);
  const root = await db.roots.get(rootId);
  const ctx: ToolContext = { rootId, planIds: [], fileIds: [] };
  const messages: ChatMessage[] = [...history, { role: "user", content: userText }];

  if (!provider) {
    // No AI connected: still useful for finding files with keyword search.
    const files = await db.files.where("rootId").equals(rootId).toArray();
    const hits = keywordSearch(files, userText).slice(0, 12);
    ctx.fileIds.push(...hits.map((h) => h.file.id));
    const reply = hits.length
      ? hits.length === 12
        ? i18n.t("agent:replies.offlineTopMatches")
        : i18n.t("agent:replies.offlineFound", { count: hits.length })
      : i18n.t("agent:replies.offlineNone");
    return { messages: [...messages, { role: "assistant", content: reply }], reply, planIds: [], fileIds: ctx.fileIds };
  }

  const system = systemPrompt(root?.name ?? "this folder", new Date().toISOString().slice(0, 10));
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await provider.chat(system, messages, TOOL_DEFS);
    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls, raw: res.raw });
    if (res.toolCalls.length === 0) {
      return { messages, reply: res.content, planIds: ctx.planIds, fileIds: [...new Set(ctx.fileIds)] };
    }
    for (const call of res.toolCalls) {
      const out = await runTool(call.name, call.input, ctx);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: out.content, isError: out.isError });
    }
  }
  const reply = ctx.planIds.length ? i18n.t("agent:replies.planReady") : i18n.t("agent:replies.stopped");
  messages.push({ role: "assistant", content: reply });
  return { messages, reply, planIds: ctx.planIds, fileIds: [...new Set(ctx.fileIds)] };
}
