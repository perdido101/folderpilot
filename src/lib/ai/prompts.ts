import type { AnalyzeContext, FileMeta } from "./types";

export const INSIGHT_JSON_SHAPE = `{"category": string, "tags": string[], "caption": string, "suggestedName": string, "client": string | null, "confidence": number, "reason": string}`;

export function insightSystemPrompt(ctx: AnalyzeContext): string {
  const parts = [
    "You help a small office (accountants, law firms, agencies) organize files on their computer.",
    "For the file described, return ONLY a JSON object with exactly these keys: " + INSIGHT_JSON_SHAPE + ".",
    "- category: a short plural noun phrase in English, e.g. Invoices, Contracts, NDAs, Receipts, Bank statements, Photos, Screenshots, Scans, Notes, Spreadsheets, Archives, Manuals.",
    "- tags: up to 6 lowercase keywords.",
    "- caption: one plain sentence describing the content.",
    "- suggestedName: a clear file name WITHOUT extension, like \"2024-03 Invoice 1001 - Alpha Ltd\". Use dates (YYYY-MM) and names only if visible in the content.",
    "- client: the client/company the file belongs to, or null.",
    "- confidence: 0 to 1. Use below 0.6 when you are guessing.",
    "- reason: one short sentence explaining the category.",
  ];
  if (ctx.knownCategories.length) parts.push(`Prefer these existing categories when they fit: ${ctx.knownCategories.join(", ")}.`);
  if (ctx.naturalRules.length) parts.push("The user's own rules (follow them):\n" + ctx.naturalRules.map((r) => `- ${r}`).join("\n"));
  return parts.join("\n");
}

export function describeMeta(meta: FileMeta): string {
  const lines = [
    `File name: ${meta.name}`,
    `Folder: ${meta.path.includes("/") ? meta.path.slice(0, meta.path.lastIndexOf("/")) : "(root)"}`,
    `Type: .${meta.ext || "unknown"}, ${meta.size} bytes, modified ${new Date(meta.mtime).toISOString().slice(0, 10)}`,
  ];
  if (meta.width && meta.height) lines.push(`Image size: ${meta.width}×${meta.height}`);
  if (meta.exif && Object.keys(meta.exif).length) lines.push(`EXIF: ${JSON.stringify(meta.exif)}`);
  if (meta.flags.length) lines.push(`Local analysis flags: ${meta.flags.join(", ")}`);
  return lines.join("\n");
}
