// Local analysis, off the main thread: SHA-256, image metrics (dHash, blur, brightness, size),
// EXIF and text excerpts (plain text + DOCX). PDF text is extracted by pdf.js in its own worker.
import exifr from "exifr";
import mammoth from "mammoth";
import { dhash, meanBrightness, sharpness, toGray } from "@/lib/analysis/image-metrics";

export interface AnalyzeRequest {
  id: number;
  file: File;
  ext: string;
  kind: string;
}

export interface AnalyzeResult {
  id: number;
  sha256?: string;
  dhash?: string;
  blurScore?: number;
  brightness?: number;
  width?: number;
  height?: number;
  exif?: Record<string, string | number>;
  textExcerpt?: string;
  error?: string;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResult): void;
};

const FULL_HASH_LIMIT = 256 * 1024 * 1024;
const PARTIAL = 4 * 1024 * 1024;
const TEXT_LIMIT = 4000;
const DECODABLE = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "ico"];
const TEXT_EXTS = ["txt", "md", "csv", "tsv", "json", "xml", "log", "ini", "yml", "yaml", "html", "htm", "rtf"];
const EXIF_EXTS = ["jpg", "jpeg", "heic", "heif", "tif", "tiff", "png", "webp", "avif"];

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(file: File): Promise<string> {
  if (file.size <= FULL_HASH_LIMIT) return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  // Huge files (videos): hash size + first and last 4 MB. Marked so it is never confused with a full hash.
  const head = await file.slice(0, PARTIAL).arrayBuffer();
  const tail = await file.slice(file.size - PARTIAL).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const joined = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  joined.set(sizeBytes, 0);
  joined.set(new Uint8Array(head), sizeBytes.length);
  joined.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);
  return `p:${hex(await crypto.subtle.digest("SHA-256", joined))}`;
}

function grayAt(bitmap: ImageBitmap, w: number, h: number): Float32Array {
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("No 2D context");
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, w, h);
  return toGray(g.getImageData(0, 0, w, h).data, w * h);
}

async function imageMetrics(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, 512 / Math.max(width, height));
    const w = Math.max(3, Math.round(width * scale));
    const h = Math.max(3, Math.round(height * scale));
    const gray = grayAt(bitmap, w, h);
    return {
      width,
      height,
      dhash: dhash(grayAt(bitmap, 9, 8)),
      blurScore: Math.round(sharpness(gray, w, h) * 10) / 10,
      brightness: Math.round(meanBrightness(gray) * 10) / 10,
    };
  } finally {
    bitmap.close();
  }
}

async function readExif(file: File): Promise<Record<string, string | number> | undefined> {
  const raw = (await exifr.parse(file, { pick: ["Make", "Model", "DateTimeOriginal", "LensModel", "latitude", "longitude", "Software"], gps: true })) as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" || typeof v === "number") out[k] = typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v.trim();
    else if (v instanceof Date && !Number.isNaN(v.getTime())) out[k] = v.toISOString();
  }
  return Object.keys(out).length ? out : undefined;
}

ctx.onmessage = async (e: MessageEvent<AnalyzeRequest>) => {
  const { id, file, ext, kind } = e.data;
  const result: AnalyzeResult = { id };
  try {
    result.sha256 = await sha256(file);
    if (kind === "image" && DECODABLE.includes(ext)) {
      try {
        Object.assign(result, await imageMetrics(file));
      } catch {
        /* undecodable image: keep hash only */
      }
    }
    if (EXIF_EXTS.includes(ext)) result.exif = await readExif(file).catch(() => undefined);
    if (TEXT_EXTS.includes(ext)) result.textExcerpt = (await file.slice(0, TEXT_LIMIT * 2).text()).replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
    if (ext === "docx") {
      const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      result.textExcerpt = value.replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  ctx.postMessage(result);
};
