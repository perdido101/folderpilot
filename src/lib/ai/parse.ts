import { FileInsightSchema, type FileInsight } from "./types";

/**
 * Pull the first JSON object out of a model reply. Models sometimes wrap JSON in
 * ```json fences or add a sentence before it, even when asked not to.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("No JSON object found in AI reply");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

/** Normalize the loose shapes small local models produce, then validate strictly. */
export function parseInsight(raw: unknown): FileInsight {
  const obj = (typeof raw === "string" ? extractJson(raw) : raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") throw new Error("AI reply is not an object");
  const tags = Array.isArray(obj.tags)
    ? obj.tags
    : typeof obj.tags === "string"
      ? obj.tags.split(",")
      : [];
  let confidence = typeof obj.confidence === "string" ? Number.parseFloat(obj.confidence) : obj.confidence;
  if (typeof confidence === "number" && confidence >= 10 && confidence <= 100) confidence /= 100; // "85" → 0.85; "7" stays invalid
  const normalized = {
    category: typeof obj.category === "string" ? obj.category.trim() : obj.category,
    tags: tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8),
    caption: typeof obj.caption === "string" ? obj.caption.trim() : "",
    suggestedName: typeof obj.suggestedName === "string" ? obj.suggestedName.trim() : typeof obj.suggested_name === "string" ? obj.suggested_name.trim() : "",
    client: typeof obj.client === "string" && obj.client.trim() ? obj.client.trim() : null,
    confidence,
    reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
  };
  return FileInsightSchema.parse(normalized);
}

/** Keep the original extension and strip characters Windows doesn't allow in file names. */
export function sanitizeSuggestedName(suggested: string, originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  const ext = dot > 0 ? originalName.slice(dot) : "";
  let base = suggested.trim();
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim();
  return base ? `${base}${ext}` : originalName;
}
