/**
 * Natural search queries (spec §11): "invoices from Alpha 2025 pdf" → words + recognized filters.
 * Recognized parts come back as chips the UI can show and remove. Shared by this device and the server.
 */
import type { FileKind } from "../file-kinds";

/** Lowercase and strip accents (so "cafe" finds "Café" and "τιμολογιο" finds "Τιμολόγιο"). */
export function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const STOPWORDS = new Set(
  "the a an of to and or for in on with from by my our find show me all files file that this those these where is are was be please about any some get list search looking look".split(" "),
);

export type ChipType = "year" | "date" | "kind" | "ext" | "flag";
export interface QueryChip {
  type: ChipType;
  /** Filter value: a year, YYYY-MM-DD..YYYY-MM-DD, a kind, an extension or a flag. */
  value: string;
  /** The words in the query that produced it (removing the chip removes them). */
  raw: string;
}

export interface ParsedQuery {
  /** Words left for full-text/semantic matching (normalized). */
  terms: string[];
  kind?: FileKind;
  ext?: string;
  flag?: string;
  /** Modified on or after (inclusive), YYYY-MM-DD. */
  from?: string;
  /** Modified before (exclusive), YYYY-MM-DD. */
  to?: string;
  chips: QueryChip[];
}

const WORDS: [RegExp, Pick<QueryChip, "type" | "value">][] = [
  [/^(photos?|images?|pictures?|pics?|φωτογραφιες|φωτογραφια|εικονες|εικονα)$/, { type: "kind", value: "image" }],
  [/^(documents?|docs)$/, { type: "kind", value: "document" }],
  [/^(spreadsheets?|excel|sheets?)$/, { type: "kind", value: "spreadsheet" }],
  [/^(videos?|movies?|βιντεο)$/, { type: "kind", value: "video" }],
  [/^(audio|music|recordings?)$/, { type: "kind", value: "audio" }],
  [/^(archives?|zips?)$/, { type: "kind", value: "archive" }],
  [/^(pdfs?)$/, { type: "ext", value: "pdf" }],
  [/^(csvs?)$/, { type: "ext", value: "csv" }],
  [/^(word|docx)$/, { type: "ext", value: "docx" }],
  [/^(screenshots?|στιγμιοτυπα|στιγμιοτυπο)$/, { type: "flag", value: "screenshot" }],
  [/^(duplicates?|copies|dupes?)$/, { type: "flag", value: "duplicate" }],
  [/^(blurry|blurred)$/, { type: "flag", value: "blurry" }],
  [/^(dark)$/, { type: "flag", value: "dark" }],
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d));

/** Relative dates ("last month", "this year", "today", "last week", "yesterday"), as [from, to). */
function relative(words: string[], i: number, now: Date): { from: string; to: string; used: number } | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const two = `${words[i]} ${words[i + 1] ?? ""}`;
  const day = (offset: number) => utc(y, m, d + offset);
  if (words[i] === "today") return { from: iso(day(0)), to: iso(day(1)), used: 1 };
  if (words[i] === "yesterday") return { from: iso(day(-1)), to: iso(day(0)), used: 1 };
  if (two === "this year") return { from: iso(utc(y, 0)), to: iso(utc(y + 1, 0)), used: 2 };
  if (two === "last year") return { from: iso(utc(y - 1, 0)), to: iso(utc(y, 0)), used: 2 };
  if (two === "this month") return { from: iso(utc(y, m)), to: iso(utc(y, m + 1)), used: 2 };
  if (two === "last month") return { from: iso(utc(y, m - 1)), to: iso(utc(y, m)), used: 2 };
  if (two === "this week" || two === "last week") {
    const weekday = (now.getUTCDay() + 6) % 7; // Monday = 0
    const start = utc(y, m, d - weekday - (two === "last week" ? 7 : 0));
    return { from: iso(start), to: iso(utc(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7)), used: 2 };
  }
  return null;
}

export function parseQuery(q: string, now = new Date()): ParsedQuery {
  const out: ParsedQuery = { terms: [], chips: [] };
  const original = q.split(/[\s,;:!?"'()]+/).filter(Boolean);
  const words = original.map((w) => norm(w).replace(/^[.#]+|[.]+$/g, ""));
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w) continue;
    const rel = relative(words, i, now);
    if (rel && !out.from) {
      out.from = rel.from;
      out.to = rel.to;
      out.chips.push({ type: "date", value: `${rel.from}..${rel.to}`, raw: original.slice(i, i + rel.used).join(" ") });
      i += rel.used - 1;
      continue;
    }
    if (/^(19|20)\d\d$/.test(w) && !out.from) {
      out.from = `${w}-01-01`;
      out.to = `${Number(w) + 1}-01-01`;
      out.chips.push({ type: "year", value: w, raw: original[i]! });
      continue;
    }
    const known = WORDS.find(([re]) => re.test(w));
    if (known) {
      const { type, value } = known[1];
      if (type === "kind" && !out.kind) out.kind = value as FileKind;
      else if (type === "ext" && !out.ext) out.ext = value;
      else if (type === "flag" && !out.flag) out.flag = value;
      else continue;
      out.chips.push({ type, value, raw: original[i]! });
      continue;
    }
    if (STOPWORDS.has(w) || w.length < 2) continue;
    out.terms.push(w);
  }
  return out;
}

/** The query with a chip's words removed (for the "×" on a chip). */
export function removeChip(q: string, chip: QueryChip): string {
  const escaped = chip.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return q
    .replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "i"), " ")
    .replace(/\s+/g, " ")
    .trim();
}
