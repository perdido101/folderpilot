/**
 * Local analysis of one file, shared by the browser (Web Worker) and the server worker. No AI, no network.
 * Environment-specific work is injected: image decoding (OffscreenCanvas / sharp) and PDF text (pdf.js builds differ).
 */
import exifr from "exifr";
import mammoth from "mammoth";
import { dhash, meanBrightness, sharpness } from "./image-metrics";

export interface DecodedImage {
  width: number;
  height: number;
  /** Grayscale (0–255) pixels of the image resized to exactly w×h. */
  grayAt(w: number, h: number): Promise<Float32Array>;
  close?(): void;
}

export interface AnalyzeDeps {
  /** Decode an image, or null if it can't be decoded here. */
  decodeImage?(data: Blob, ext: string): Promise<DecodedImage | null>;
  /** Text of the first pages of a PDF. */
  pdfText?(data: Blob, maxChars: number): Promise<string>;
}

export interface AnalyzeInput {
  data: Blob;
  ext: string;
  kind: string;
}

export interface AnalysisResult {
  sha256?: string;
  dhash?: string;
  blurScore?: number;
  brightness?: number;
  width?: number;
  height?: number;
  exif?: Record<string, string | number>;
  textExcerpt?: string;
  /** Non-fatal problems (e.g. an undecodable image); the rest of the result is still valid. */
  warnings: string[];
}

export const FULL_HASH_LIMIT = 256 * 1024 * 1024;
const PARTIAL = 4 * 1024 * 1024;
export const TEXT_LIMIT = 4000;
export const DECODABLE_IMAGES = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "tif", "tiff"];
export const TEXT_EXTS = ["txt", "md", "csv", "tsv", "json", "xml", "log", "ini", "yml", "yaml", "html", "htm", "rtf"];
const EXIF_EXTS = ["jpg", "jpeg", "heic", "heif", "tif", "tiff", "png", "webp", "avif"];
const EXIF_PICK = ["Make", "Model", "DateTimeOriginal", "LensModel", "latitude", "longitude", "Software"];

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const squash = (s: string, max = TEXT_LIMIT) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** SHA-256 of the content. Files over 256 MB hash size + first and last 4 MB, marked "p:" so it's never confused with a full hash. */
export async function sha256(data: Blob): Promise<string> {
  if (data.size <= FULL_HASH_LIMIT) return hex(await crypto.subtle.digest("SHA-256", await data.arrayBuffer()));
  const head = new Uint8Array(await data.slice(0, PARTIAL).arrayBuffer());
  const tail = new Uint8Array(await data.slice(data.size - PARTIAL).arrayBuffer());
  const size = new TextEncoder().encode(String(data.size));
  const joined = new Uint8Array(size.length + head.length + tail.length);
  joined.set(size, 0);
  joined.set(head, size.length);
  joined.set(tail, size.length + head.length);
  return `p:${hex(await crypto.subtle.digest("SHA-256", joined))}`;
}

export async function imageMetrics(img: DecodedImage) {
  const scale = Math.min(1, 512 / Math.max(img.width, img.height));
  const w = Math.max(3, Math.round(img.width * scale));
  const h = Math.max(3, Math.round(img.height * scale));
  const gray = await img.grayAt(w, h);
  return {
    width: img.width,
    height: img.height,
    dhash: dhash(await img.grayAt(9, 8)),
    blurScore: Math.round(sharpness(gray, w, h) * 10) / 10,
    brightness: Math.round(meanBrightness(gray) * 10) / 10,
  };
}

export async function readExif(data: Blob): Promise<Record<string, string | number> | undefined> {
  const raw = (await exifr.parse(new Uint8Array(await data.arrayBuffer()), { pick: EXIF_PICK, gps: true })) as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number") out[k] = Math.round(v * 1e5) / 1e5;
    else if (typeof v === "string") out[k] = v.trim();
    else if (v instanceof Date && !Number.isNaN(v.getTime())) out[k] = v.toISOString();
  }
  return Object.keys(out).length ? out : undefined;
}

export async function docxText(data: Blob): Promise<string> {
  const arrayBuffer = await data.arrayBuffer();
  // The browser build of mammoth reads `arrayBuffer`, the Node build reads `buffer`; JSZip accepts an ArrayBuffer for both.
  const { value } = await mammoth.extractRawText({ arrayBuffer, buffer: arrayBuffer } as unknown as { arrayBuffer: ArrayBuffer });
  return squash(value);
}

/** Hash, image metrics, EXIF and a text excerpt for one file. Never throws for content problems. */
export async function analyzeFile(input: AnalyzeInput, deps: AnalyzeDeps = {}): Promise<AnalysisResult> {
  const { data, ext } = input;
  const result: AnalysisResult = { warnings: [] };
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      result.warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  result.sha256 = await sha256(data);

  if (input.kind === "image" && DECODABLE_IMAGES.includes(ext) && deps.decodeImage) {
    await attempt("image", async () => {
      const img = await deps.decodeImage!(data, ext);
      if (!img) return;
      try {
        Object.assign(result, await imageMetrics(img));
      } finally {
        img.close?.();
      }
    });
  }
  if (EXIF_EXTS.includes(ext)) {
    await attempt("exif", async () => {
      const exif = await readExif(data);
      if (exif) result.exif = exif;
    });
  }
  if (TEXT_EXTS.includes(ext)) {
    await attempt("text", async () => {
      result.textExcerpt = squash(await data.slice(0, TEXT_LIMIT * 4).text());
    });
  } else if (ext === "docx") {
    await attempt("docx", async () => {
      result.textExcerpt = await docxText(data);
    });
  } else if (ext === "pdf" && deps.pdfText) {
    await attempt("pdf", async () => {
      result.textExcerpt = squash(await deps.pdfText!(data, TEXT_LIMIT));
    });
  }
  return result;
}
