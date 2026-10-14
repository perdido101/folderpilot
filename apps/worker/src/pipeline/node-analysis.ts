/** Node-side hooks for the shared analyzer: image decoding with sharp, PDF text with the pdf.js legacy build. */
import sharp from "sharp";
import type { AnalyzeDeps, DecodedImage } from "@folderpilot/analysis";

async function decodeImage(data: Blob): Promise<DecodedImage | null> {
  const input = Buffer.from(await data.arrayBuffer());
  const meta = await sharp(input, { failOn: "none" }).rotate().metadata();
  if (!meta.width || !meta.height) return null;
  // EXIF orientation applied, so width/height match what people see.
  const swapped = (meta.orientation ?? 1) >= 5;
  return {
    width: swapped ? meta.height : meta.width,
    height: swapped ? meta.width : meta.height,
    async grayAt(w, h) {
      // Same weights as toGray() (0.299 R + 0.587 G + 0.114 B) so results match the browser.
      const { data: rgb } = await sharp(input, { failOn: "none" }).rotate().resize(w, h, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
      const out = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) out[i] = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
      return out;
    },
  };
}

async function pdfText(data: Blob, maxChars: number): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await data.arrayBuffer()), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const parts: string[] = [];
    for (let p = 1; p <= Math.min(2, doc.numPages); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return parts.join("\n").slice(0, maxChars * 2);
  } finally {
    await doc.destroy();
  }
}

export const nodeAnalyzeDeps: AnalyzeDeps = { decodeImage, pdfText };

/** A ≤512px JPEG for the AI (never the full file). */
export async function aiThumbnail(data: Blob): Promise<Blob | null> {
  try {
    const buf = await sharp(Buffer.from(await data.arrayBuffer()), { failOn: "none" }).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return new Blob([new Uint8Array(buf)], { type: "image/jpeg" });
  } catch {
    return null;
  }
}
